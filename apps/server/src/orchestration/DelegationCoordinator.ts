import {
  DelegateStartInput,
  DelegatedRunId,
  DelegationAttemptId,
  DelegationBatchId,
  DelegationRequestHash,
  DelegationRouteGroupId,
  DelegationWorkflowId,
  ProviderDriverKind,
  SubagentRunId,
  type DelegateStartResult,
  type DelegateStartInput as DelegateStartRequest,
  type DelegatedRun,
  type DelegationDeliveryMode,
  type DelegationReasonCode,
  type ProjectMcpOverrides,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  DelegationRouterService,
  type DelegationRoutingSnapshot,
} from "../provider/DelegationRouterService.ts";
import type { TrustedRoutingContext } from "../provider/DelegationRouter.ts";
import { DelegatedRunRepository } from "./DelegatedRunRepository.ts";
import { DelegatedRunService } from "./DelegatedRunService.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { SubagentRunService } from "./SubagentRunService.ts";

const MAX_REVISION_RETRIES = 3;
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDelegateStartInput = Schema.decodeUnknownEffect(DelegateStartInput);
const callerContextBrand: unique symbol = Symbol("DelegationCallerContext");

export interface DelegationCallerContext {
  readonly [callerContextBrand]: true;
  readonly sessionKind: "parent" | "delegated";
  readonly trustedRoutingContext?: TrustedRoutingContext | undefined;
}

export const makeDelegationCallerContext = (
  input: Omit<DelegationCallerContext, typeof callerContextBrand>,
): DelegationCallerContext => ({ ...input, [callerContextBrand]: true });

export interface StartDelegationInput {
  readonly parentThreadId: ThreadId;
  readonly request: DelegateStartRequest;
  readonly deliveryMode?: DelegationDeliveryMode | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly callerContext: DelegationCallerContext;
}

export class DelegationCoordinatorError extends Schema.TaggedErrorClass<DelegationCoordinatorError>()(
  "DelegationCoordinatorError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export interface DelegationCoordinatorShape {
  readonly start: (
    input: StartDelegationInput,
  ) => Effect.Effect<DelegateStartResult, DelegationCoordinatorError>;
}

export class DelegationCoordinator extends Context.Service<
  DelegationCoordinator,
  DelegationCoordinatorShape
>()("t3/orchestration/DelegationCoordinator") {}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const entry = value[key];
        return entry === undefined ? [] : [[key, canonicalize(entry)]];
      }),
  );
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const repository = yield* DelegatedRunRepository;
  const router = yield* DelegationRouterService;
  const delegatedRuns = yield* DelegatedRunService;
  const subagentRuns = yield* SubagentRunService;
  const projections = yield* ProjectionSnapshotQuery;
  const fail = (reason: DelegationReasonCode | "invalid_request", message: string) =>
    new DelegationCoordinatorError({ reason, message });

  const resultFromRuns = (
    tasks: DelegateStartRequest["tasks"],
    runs: ReadonlyArray<DelegatedRun>,
  ): Effect.Effect<DelegateStartResult, DelegationCoordinatorError> =>
    Effect.gen(function* () {
      const first = runs[0];
      if (!first?.workflowId || !first.batchId) {
        return yield* fail(
          "persistence_unavailable",
          "The idempotent delegation batch is missing workflow metadata.",
        );
      }
      const runsByLane = new Map(runs.map((run) => [run.laneId, run]));
      return {
        workflowId: first.workflowId,
        batchId: first.batchId,
        allocationStatus: "allocated",
        runs: yield* Effect.forEach(tasks, (task) =>
          Effect.gen(function* () {
            const run = runsByLane.get(task.laneId);
            const decision = run?.routeDecision;
            if (!run || !decision) {
              return yield* fail(
                "persistence_unavailable",
                `The idempotent delegation batch is missing lane '${task.laneId}'.`,
              );
            }
            return {
              laneId: task.laneId,
              runId: run.id,
              route: {
                decisionId: decision.decisionId,
                policyVersion: decision.policyVersion,
                role: decision.role,
                provider: decision.selected.provider,
                providerInstanceId: decision.selected.providerInstanceId,
                ...(decision.selected.model ? { model: decision.selected.model } : {}),
                explanation: decision.explanation,
              },
            };
          }),
        ),
      };
    });

  const requestHash = Effect.fn("DelegationCoordinator.requestHash")(function* (value: unknown) {
    const encoded = yield* encodeUnknownJson(canonicalize(value)).pipe(
      Effect.mapError(() =>
        fail("persistence_unavailable", "Could not encode delegation request."),
      ),
    );
    const bytes = new TextEncoder().encode(encoded);
    const digest = yield* crypto
      .digest("SHA-256", bytes)
      .pipe(
        Effect.mapError(() =>
          fail("persistence_unavailable", "Could not hash delegation request."),
        ),
      );
    return DelegationRequestHash.make(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

  const randomId = Effect.fn("DelegationCoordinator.randomId")(function* (prefix: string) {
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => fail("persistence_unavailable", "Could not allocate delegation IDs.")),
    );
    return `${prefix}-${uuid}`;
  });

  const validateAttachments = Effect.fn("DelegationCoordinator.validateAttachments")(function* (
    parentThreadId: ThreadId,
    request: DelegateStartRequest,
  ) {
    const ownerSegment = toSafeThreadAttachmentSegment(parentThreadId);
    for (const task of request.tasks) {
      for (const attachment of task.attachments ?? []) {
        if (
          ownerSegment === null ||
          parseThreadSegmentFromAttachmentId(attachment.id) !== ownerSegment
        ) {
          return yield* fail(
            "attachment_unavailable",
            `Attachment '${attachment.id}' is not owned by the parent thread.`,
          );
        }
        const attachmentPath = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
        });
        if (attachmentPath === null) {
          return yield* fail(
            "attachment_unavailable",
            `Attachment '${attachment.id}' does not exist.`,
          );
        }
        const info = yield* fs
          .stat(attachmentPath)
          .pipe(
            Effect.mapError(() =>
              fail("attachment_unavailable", `Attachment '${attachment.id}' is unavailable.`),
            ),
          );
        if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes) {
          return yield* fail(
            "attachment_unavailable",
            `Attachment '${attachment.id}' does not match its persisted metadata.`,
          );
        }
      }
    }
  });

  const start: DelegationCoordinatorShape["start"] = Effect.fn("DelegationCoordinator.start")(
    function* (input) {
      if (!(callerContextBrand in input.callerContext)) {
        return yield* fail("recursion_forbidden", "Delegation requires trusted server context.");
      }
      const decoded = yield* decodeDelegateStartInput(input.request).pipe(
        Effect.mapError(() =>
          fail("invalid_request", "The delegation request is structurally invalid."),
        ),
      );
      const parent = yield* projections.getThreadDetailById(input.parentThreadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(() => fail("invalid_request", "Could not read the parent thread.")),
      );
      if (!parent) return yield* fail("invalid_request", "The parent thread no longer exists.");
      const project = yield* projections.getProjectShellById(parent.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(() => fail("invalid_request", "Could not read the parent project.")),
      );
      if (!project) return yield* fail("invalid_request", "The parent project no longer exists.");
      if (decoded.tasks.length === 0) {
        return yield* fail("invalid_request", "At least one delegation lane is required.");
      }
      const laneIds = decoded.tasks.map((task) => task.laneId);
      if (new Set(laneIds).size !== laneIds.length) {
        return yield* fail("invalid_request", "Delegation lane identifiers must be unique.");
      }
      yield* validateAttachments(input.parentThreadId, decoded);

      const workspaceRoot = input.workspaceRoot ?? parent.worktreePath ?? project.workspaceRoot;
      const canonicalWorkspace = yield* repository
        .canonicalizeWorkspace({
          workspaceRoot,
          authorizedRoots: [parent.worktreePath, project.workspaceRoot].filter(
            (root): root is string => root !== null,
          ),
        })
        .pipe(Effect.mapError((error) => fail("invalid_request", error.message)));
      const projectOverrides =
        project.mcpOverrides === null
          ? undefined
          : (project.mcpOverrides as ProjectMcpOverrides | undefined);
      const hash = yield* requestHash({
        parentThreadId: input.parentThreadId,
        workspaceRoot: canonicalWorkspace,
        deliveryMode: input.deliveryMode ?? "parent_wake",
        tasks: decoded.tasks,
      });
      const replay = yield* repository
        .findBatchByIdempotency(config.stateDir, input.parentThreadId, decoded.idempotencyKey, hash)
        .pipe(
          Effect.mapError((error) =>
            fail(
              error.reason === "idempotency_conflict"
                ? "idempotency_conflict"
                : "persistence_unavailable",
              error.message,
            ),
          ),
        );
      if (replay) return yield* resultFromRuns(decoded.tasks, replay);

      const routeGroupId = DelegationRouteGroupId.make(yield* randomId("route"));
      const routeInput = {
        routeGroupId,
        tasks: decoded.tasks,
        projectOverrides,
        trustedContext: input.callerContext.trustedRoutingContext,
        invokedByDelegatedChild: input.callerContext.sessionKind === "delegated",
      };

      let snapshot: DelegationRoutingSnapshot | undefined;
      for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
        const evaluated = yield* router.route(routeInput);
        if (decoded.tasks.length > evaluated.routerSettings.maxBatchSize) {
          return yield* fail(
            "invalid_request",
            `A delegation batch may contain at most ${evaluated.routerSettings.maxBatchSize} tasks.`,
          );
        }
        if (!evaluated.result.ok) {
          const first = evaluated.result.failures[0]!;
          return yield* fail(first.reasonCode, first.explanation);
        }
        const confirmed = yield* router.route(routeInput);
        if (
          evaluated.settingsRevision === confirmed.settingsRevision &&
          evaluated.providerRevision === confirmed.providerRevision
        ) {
          snapshot = confirmed;
          break;
        }
      }
      if (!snapshot || !snapshot.result.ok) {
        return yield* fail(
          "provider_unavailable",
          "Delegation settings or providers changed repeatedly during admission.",
        );
      }
      if (snapshot.shadow) {
        return yield* fail(
          "delegation_disabled",
          "Delegation routing is in shadow evaluation; no run was started.",
        );
      }

      const workflowId = DelegationWorkflowId.make(yield* randomId("workflow"));
      const batchId = DelegationBatchId.make(yield* randomId("batch"));
      const now = DateTime.formatIso(yield* DateTime.now);
      const allocations = yield* Effect.forEach(decoded.tasks, (task) =>
        Effect.gen(function* () {
          const decision = snapshot!.result.ok
            ? snapshot!.result.decisions.find((candidate) =>
                candidate.decisionId.endsWith(`:${task.laneId}`),
              )
            : undefined;
          if (!decision) {
            return yield* fail(
              "provider_unavailable",
              `No route exists for lane '${task.laneId}'.`,
            );
          }
          const runId = DelegatedRunId.make(yield* randomId("delegated"));
          const run: DelegatedRun = {
            id: runId,
            provider: decision.selected.provider,
            providerInstanceId: decision.selected.providerInstanceId,
            parentThreadId: input.parentThreadId,
            workflowId,
            batchId,
            laneId: task.laneId,
            routeGroupId,
            deliveryMode: input.deliveryMode ?? "parent_wake",
            routeDecision: decision,
            providerThreadId: `delegated-${runId}`,
            title: task.title,
            taskPreview: task.task.slice(0, 500),
            status: "queued",
            lastSummary: null,
            finalMessage: null,
            error: null,
            ...(decision.selected.model
              ? { model: decision.selected.model, resolvedModel: decision.selected.model }
              : {}),
            ...(task.providerConstraint?.model
              ? { requestedModel: task.providerConstraint.model }
              : {}),
            ...(task.providerConstraint?.options
              ? { requestedOptions: task.providerConstraint.options }
              : {}),
            ...(decision.selected.options ? { resolvedOptions: decision.selected.options } : {}),
            interactionMode: task.interactionMode ?? "default",
            approvalPolicy: "never",
            sandboxMode: task.workspaceAccess === "read-only" ? "read-only" : "workspace-write",
            runtimeMode:
              task.workspaceAccess === "read-only" ? "approval-required" : "auto-accept-edits",
            attachments: task.attachments ?? [],
            workspaceRoot: canonicalWorkspace,
            sequence: 0,
            dispatchState: "allocated",
            allocatedAt: now,
            attempts: [
              {
                attemptId: DelegationAttemptId.make(`${runId}:1`),
                target: decision.selected,
                dispatchState: "allocated",
                allocatedAt: now,
              },
            ],
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          return { task, decision, run };
        }),
      );
      const commitSnapshot = yield* router.route(routeInput);
      if (
        commitSnapshot.settingsRevision !== snapshot.settingsRevision ||
        commitSnapshot.providerRevision !== snapshot.providerRevision
      ) {
        return yield* fail(
          "provider_unavailable",
          "Delegation settings or providers changed immediately before admission commit.",
        );
      }

      const reservation = yield* repository
        .reserveBatch({
          batchId,
          workflowId,
          environmentId: config.stateDir,
          parentThreadId: input.parentThreadId,
          runs: allocations.map(({ task, run }) => ({
            run,
            canonicalWorkspace,
            workspaceAccess: task.workspaceAccess,
          })),
          limits: {
            maxConcurrentPerParent: snapshot.routerSettings.maxConcurrentPerParent,
            maxConcurrentEnvironment: snapshot.routerSettings.maxConcurrentEnvironment,
          },
          idempotency: { key: decoded.idempotencyKey, requestHash: hash },
        })
        .pipe(
          Effect.mapError((error) =>
            fail(
              error.reason === "corrupt_repository" ||
                error.reason === "run_not_found" ||
                error.reason === "workspace_outside_authorized_root"
                ? "persistence_unavailable"
                : error.reason,
              error.message,
            ),
          ),
        );

      const allocatedById = new Map(reservation.runs.map((run) => [run.laneId, run]));
      const first = reservation.runs[0]!;
      const effectiveWorkflowId = first.workflowId ?? workflowId;
      const effectiveBatchId = first.batchId ?? batchId;
      if (reservation.kind === "allocated") {
        yield* subagentRuns.upsert({
          eventId: `delegation-workflow:${effectiveWorkflowId}:allocated`,
          run: {
            id: SubagentRunId.make(effectiveWorkflowId),
            source: "delegated",
            provider: ProviderDriverKind.make(first.provider),
            providerInstanceId: first.providerInstanceId,
            rootThreadId: input.parentThreadId,
            depth: 0,
            title:
              decoded.tasks.length === 1
                ? decoded.tasks[0]!.title
                : `${decoded.tasks.length} delegated tasks`,
            taskPreview: decoded.tasks
              .map((task) => task.title)
              .join(", ")
              .slice(0, 500),
            modelResolution: "unknown",
            status: "queued",
            lastSummary: null,
            finalMessage: null,
            error: null,
            capabilities: {
              canCancel: true,
              canSteer: false,
              canRespond: false,
              canResume: false,
              transcriptQuality: "none",
            },
            runKind: "workflow",
            workflowId: effectiveWorkflowId,
            batchId: effectiveBatchId,
            createdAt: now,
            startedAt: null,
            completedAt: null,
            updatedAt: now,
            sequence: 0,
          },
        });
        yield* Effect.forEach(
          allocations,
          ({ task, decision }) => {
            const run = allocatedById.get(task.laneId)!;
            return delegatedRuns
              .startAllocated({
                run,
                task: task.task,
                fallbackTargets: decision.fallbackChain,
                timeoutMs: snapshot!.routerSettings.defaultTimeoutMs,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const failedAt = DateTime.formatIso(yield* DateTime.now);
                    const message = Cause.pretty(cause);
                    yield* repository
                      .update(run.id, (current) => ({
                        ...current,
                        status: "failed",
                        error: message,
                        completedAt: failedAt,
                        updatedAt: failedAt,
                        sequence: current.sequence + 1,
                      }))
                      .pipe(Effect.ignore);
                    yield* delegatedRuns.reconcileParentDelivery(run.parentThreadId);
                  }),
                ),
              );
          },
          { concurrency: 4, discard: true },
        );
      }

      return yield* resultFromRuns(decoded.tasks, reservation.runs);
    },
  );

  return DelegationCoordinator.of({ start });
});

export const layer = Layer.effect(DelegationCoordinator, make);

export const __testing = { make };

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DelegateStartInput,
  DelegateStartResult,
  DelegationAttempt,
  DelegationIdempotencyConflict,
  DelegationReasonCode,
  DelegationResultMetadata,
  DelegationRouteDecision,
  DelegationRouterSettings,
} from "./delegationRouter.ts";

const decodeRouteDecision = Schema.decodeUnknownSync(DelegationRouteDecision);
const decodeReasonCode = Schema.decodeUnknownSync(DelegationReasonCode);
const decodeAttempt = Schema.decodeUnknownSync(DelegationAttempt);
const decodeResultMetadata = Schema.decodeUnknownSync(DelegationResultMetadata);
const decodeStartResult = Schema.decodeUnknownSync(DelegateStartResult);
const decodeIdempotencyConflict = Schema.decodeUnknownSync(DelegationIdempotencyConflict);

describe("DelegateStartInput", () => {
  const decode = Schema.decodeUnknownSync(DelegateStartInput);

  it("decodes provider-neutral tasks with execution inputs and explicit constraints", () => {
    expect(
      decode({
        idempotencyKey: "request-1",
        tasks: [
          {
            laneId: "research",
            title: "Review routing",
            task: "Inspect the routing boundary",
            kind: "research",
            role: "scout",
            workspaceAccess: "read-only",
            attachments: [
              {
                type: "image",
                id: "diagram",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 42,
              },
            ],
            interactionMode: "plan",
            requiredCapabilities: { structuredQuestions: true },
            providerConstraint: {
              provider: "codex",
              providerInstanceId: "codex_work",
              model: "gpt-5.6-sol",
              options: { reasoningEffort: "high" },
            },
          },
        ],
      }),
    ).toMatchObject({
      idempotencyKey: "request-1",
      tasks: [
        {
          laneId: "research",
          workspaceAccess: "read-only",
          providerConstraint: {
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      ],
    });
  });

  it("requires one to four tasks and does not accept a caller-supplied turn limit", () => {
    expect(() => decode({ idempotencyKey: "request-1", tasks: [] })).toThrow();
    expect(() =>
      decode({
        idempotencyKey: "request-1",
        tasks: Array.from({ length: 5 }, (_, index) => ({
          laneId: `lane-${index}`,
          title: `Lane ${index}`,
          task: "Work",
          workspaceAccess: "workspace-write",
        })),
      }),
    ).toThrow();
    expect(decode({ idempotencyKey: "request-1", tasks: [task] })).not.toHaveProperty(
      "maxRunsPerTurn",
    );
  });
});

const task = {
  laneId: "lane-1",
  title: "Review",
  task: "Review the implementation",
  workspaceAccess: "workspace-write",
} as const;

const candidate = {
  provider: "codex",
  providerInstanceId: "codex_work",
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} as const;

describe("Delegation router records", () => {
  it("decodes stable route decisions and candidate reason codes", () => {
    const decision = decodeRouteDecision({
      decisionId: "decision-1",
      policyVersion: 1,
      mode: "suggested",
      taskKind: "review",
      role: "worker",
      selected: candidate,
      candidates: [
        { candidate, eligible: true, reasonCodes: [] },
        {
          candidate: { provider: "cursor", providerInstanceId: "cursor" },
          eligible: false,
          reasonCodes: ["missing_questions", "read_only_unenforced"],
        },
      ],
      fallbackChain: [{ provider: "cursor", providerInstanceId: "cursor" }],
      policySource: "role_chain",
      chainPosition: 0,
      explanation: "Selected the first eligible worker target.",
    });

    expect(decision.candidates[1]?.reasonCodes).toEqual([
      "missing_questions",
      "read_only_unenforced",
    ]);
    expect(() => decodeReasonCode("unknown_reason")).toThrow();
  });

  it("decodes append-only attempt and structural completeness metadata", () => {
    expect(
      decodeAttempt({
        attemptId: "attempt-2",
        target: candidate,
        fallbackFrom: { provider: "cursor", providerInstanceId: "cursor" },
        dispatchState: "dispatch_started",
        allocatedAt: "2026-07-29T00:00:00.000Z",
        dispatchStartedAt: "2026-07-29T00:00:01.000Z",
        failureReason: "Provider connection closed.",
        failureReasonCode: "provider_unavailable",
      }).fallbackFrom?.provider,
    ).toBe("cursor");

    expect(
      decodeResultMetadata({
        terminalEventSeen: true,
        assistantMessageCount: 2,
        finalMessagePresent: true,
        resultCompleteness: "terminal_message",
      }).resultCompleteness,
    ).toBe("terminal_message");
  });

  it("decodes allocation results and typed idempotency conflicts", () => {
    const route = {
      decisionId: "decision-1",
      policyVersion: 1,
      role: "worker",
      provider: "codex",
      providerInstanceId: "codex_work",
      model: "gpt-5.6-sol",
      explanation: "Selected the first eligible worker target.",
    };
    expect(
      decodeStartResult({
        workflowId: "workflow-1",
        batchId: "batch-1",
        allocationStatus: "allocated",
        runs: [{ laneId: "lane-1", runId: "run-1", route }],
      }).allocationStatus,
    ).toBe("allocated");
    expect(
      decodeIdempotencyConflict({
        reason: "idempotency_conflict",
        idempotencyKey: "request-1",
        existingBatchId: "batch-1",
        existingRequestHash: "sha256:old",
        requestHash: "sha256:new",
        message: "The key already owns a different request.",
      }).reason,
    ).toBe("idempotency_conflict");
  });
});

describe("DelegationRouterSettings", () => {
  const decode = Schema.decodeUnknownSync(DelegationRouterSettings);

  it("hydrates conservative defaults for legacy settings", () => {
    expect(decode({})).toEqual({
      mode: "off",
      maxBatchSize: 4,
      maxConcurrentPerParent: 4,
      maxConcurrentEnvironment: 8,
      defaultTimeoutMs: 1_800_000,
      diversity: "prefer",
      fallback: "pre-dispatch",
      explanation: "summary",
    });
  });

  it("bounds enforceable limits without introducing maxRunsPerTurn", () => {
    expect(() => decode({ maxBatchSize: 5 })).toThrow();
    expect(() => decode({ maxConcurrentPerParent: 0 })).toThrow();
    expect(() => decode({ defaultTimeoutMs: 0 })).toThrow();
    expect(decode({})).not.toHaveProperty("maxRunsPerTurn");
  });
});

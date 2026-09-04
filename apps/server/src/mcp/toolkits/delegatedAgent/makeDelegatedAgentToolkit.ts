import {
  DELEGATED_PROVIDERS,
  delegatedToolName,
  DelegatedRun,
  DelegatedRunCancelResult,
  DelegatedRunCapabilities,
  DelegatedRunError,
  DelegatedRunLookupInput,
  DelegatedRunRespondInput,
  DelegatedRunToolStartInput,
  type DelegatedRunLookupInput as DelegatedRunLookupInputType,
  type DelegatedRunRespondInput as DelegatedRunRespondInputType,
  type DelegatedRunToolStartInput as DelegatedRunToolStartInputType,
  type DelegatedProviderSpec,
  type DelegatedRunId,
  type DelegatedRunProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import {
  cancelActiveDelegatedRun,
  DelegatedRunService,
  getActiveDelegatedCapabilities,
  getActiveDelegatedRun,
  respondToActiveDelegatedRun,
  startActiveDelegatedRun,
} from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export interface DelegatedAgentToolkitSpec<P extends DelegatedRunProvider> {
  readonly provider: P;
  /** How an agent would otherwise shell out, e.g. "codex exec". Used in the start description. */
  readonly shellCommandHint: string;
  /** Provider-specific guidance appended to the start description. */
  readonly startNotes?: string;
}

const dependencies = [McpInvocationContext.McpInvocationContext, DelegatedRunService];

export const startDescription = (
  meta: DelegatedProviderSpec,
  spec: Pick<
    DelegatedAgentToolkitSpec<DelegatedRunProvider>,
    "provider" | "shellCommandHint" | "startNotes"
  >,
): string => {
  if (spec.provider === "antigravity") {
    return [
      `Start a tracked ${meta.label} ACP subagent in the parent thread workspace.`,
      spec.startNotes,
      "Provide a stable idempotencyKey for retry-safe calls.",
      `Always use this tool instead of launching ${spec.shellCommandHint} through a shell.`,
      "Returns immediately with tracked allocation state; provider acceptance happens later.",
      "Start every needed run, then end your turn; the server delivers results automatically.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const deliverySuffix = meta.supportsQuestions
    ? "the server delivers results and questions automatically."
    : "the server delivers results automatically.";

  return [
    `Start a one-shot ${meta.label} subagent in the parent thread workspace.`,
    "Execution is fixed to workspace-write with automatic edit acceptance; express a read-only task in the task text.",
    "Provide a stable idempotencyKey for retry-safe calls; omitted keys preserve legacy behavior and have no retry deduplication.",
    spec.startNotes,
    `Always use this tool instead of launching ${spec.shellCommandHint} through a shell.`,
    "Returns immediately with tracked allocation state; provider acceptance happens later.",
    `Start every needed run, then end your turn; ${deliverySuffix}`,
  ]
    .filter(Boolean)
    .join(" ");
};

const capabilitiesDescription = (meta: DelegatedProviderSpec, provider: DelegatedRunProvider) =>
  provider === "antigravity"
    ? `Report the capabilities of the ${meta.label} delegated-run backend.`
    : `Report the capabilities of the built-in ${meta.label} delegated-run backend.`;

export const makeDelegatedAgentToolkit = <P extends DelegatedRunProvider>(
  spec: DelegatedAgentToolkitSpec<P>,
) => {
  const meta = DELEGATED_PROVIDERS[spec.provider];

  const requireCapability = McpInvocationContext.requireMcpCapability(meta.capability).pipe(
    Effect.mapError(
      () =>
        new DelegatedRunError({
          operation: "start",
          message: `This session does not grant the ${meta.label} Agent capability.`,
        }),
    ),
  );

  const ownedRun = Effect.fn(`${meta.toolPrefix}AgentToolkit.ownedRun`)(function* (
    runId: DelegatedRunId,
  ) {
    const scope = yield* requireCapability;
    const run = yield* getActiveDelegatedRun(runId);
    if (
      run.parentThreadId !== McpInvocationContext.mcpOwnerThreadId(scope) ||
      run.provider !== spec.provider
    ) {
      return yield* new DelegatedRunError({
        operation: "status",
        message: "Delegated run not found for this parent thread.",
        runId,
      });
    }
    return run;
  });

  const capabilitiesTool = Tool.make(delegatedToolName(spec.provider, "capabilities"), {
    description: capabilitiesDescription(meta, spec.provider),
    success: DelegatedRunCapabilities,
    failure: DelegatedRunError,
    dependencies,
  })
    .annotate(Tool.Title, `Get ${meta.label} delegation capabilities`)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true);

  const startTool = Tool.make(delegatedToolName(spec.provider, "start"), {
    description: startDescription(meta, spec),
    parameters: DelegatedRunToolStartInput,
    success: DelegatedRun,
    failure: DelegatedRunError,
    dependencies,
  }).annotate(Tool.Title, `Start ${meta.label} subagent`);

  const cancelTool = Tool.make(delegatedToolName(spec.provider, "cancel"), {
    description: `Cancel a running ${meta.label} delegated run owned by the current parent thread.`,
    parameters: DelegatedRunLookupInput,
    success: DelegatedRunCancelResult,
    failure: DelegatedRunError,
    dependencies,
  }).annotate(Tool.Title, `Cancel ${meta.label} subagent`);

  const respondTool = meta.supportsQuestions
    ? Tool.make(delegatedToolName(spec.provider, "respond"), {
        description: `Answer a structured question requested by a waiting ${meta.label} delegated run. This does not send arbitrary follow-up prompts. After responding, end your turn; the server delivers the final result automatically.`,
        parameters: DelegatedRunRespondInput,
        success: DelegatedRun,
        failure: DelegatedRunError,
        dependencies,
      }).annotate(Tool.Title, `Respond to ${meta.label} subagent question`)
    : undefined;

  const capabilities = () =>
    requireCapability.pipe(Effect.andThen(getActiveDelegatedCapabilities(spec.provider)));

  const start = (input: DelegatedRunToolStartInputType) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      const { idempotencyKey, ...startInput } = input;
      return yield* startActiveDelegatedRun({
        ...startInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        provider: spec.provider,
        parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
      });
    });

  const cancel = ({ runId }: DelegatedRunLookupInputType) =>
    ownedRun(runId).pipe(
      Effect.andThen(cancelActiveDelegatedRun(runId)),
      Effect.map((cancelled) => ({ runId, cancelled })),
    );

  const respond = ({ runId, answers }: DelegatedRunRespondInputType) =>
    ownedRun(runId).pipe(Effect.andThen(respondToActiveDelegatedRun(runId, answers)));

  if (respondTool) {
    const toolkit = Toolkit.make(capabilitiesTool, startTool, cancelTool, respondTool);
    const handlersLayer = toolkit.toLayer({
      [capabilitiesTool.name]: capabilities,
      [startTool.name]: start,
      [cancelTool.name]: cancel,
      [respondTool.name]: respond,
    } as unknown as Toolkit.HandlersFrom<typeof toolkit.tools>);
    return {
      provider: spec.provider,
      toolkit,
      handlers: { capabilities, start, cancel, respond },
      handlersLayer,
      layer: McpServer.toolkit(toolkit).pipe(Layer.provide(handlersLayer)),
    };
  }

  const toolkit = Toolkit.make(capabilitiesTool, startTool, cancelTool);
  const handlersLayer = toolkit.toLayer({
    [capabilitiesTool.name]: capabilities,
    [startTool.name]: start,
    [cancelTool.name]: cancel,
  } as unknown as Toolkit.HandlersFrom<typeof toolkit.tools>);

  return {
    provider: spec.provider,
    toolkit,
    handlers: { capabilities, start, cancel },
    handlersLayer,
    layer: McpServer.toolkit(toolkit).pipe(Layer.provide(handlersLayer)),
  };
};

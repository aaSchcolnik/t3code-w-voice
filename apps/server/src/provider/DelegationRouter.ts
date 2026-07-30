import {
  DELEGATION_ROUTER_POLICY_VERSION,
  DelegatedRunProvider,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type DelegationCandidateEvaluation,
  type DelegationCandidateRef,
  type DelegationLaneId,
  type DelegationPolicySource,
  type DelegationReasonCode,
  type DelegationRouteDecision,
  type DelegationRouteDecisionId,
  type DelegationRouteGroupId,
  type DelegationRouterSettings,
  type DelegationTaskSpec,
  type DelegationProvider,
  type EngineDelegationSettings,
  type EngineDelegationSkillOverride,
  type EngineDelegationTarget,
  type EngineWorkflowName,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  resolveDelegationRoutingChain,
  type ResolvedDelegationRoutingChain,
} from "../knowledge/skills/delegation.ts";
import type { ProviderDelegationCapabilities } from "./Services/ProviderAdapter.ts";
import { resolveDelegatedProvider } from "./DelegatedProviderResolver.ts";

export interface DelegationRouterProvider {
  readonly snapshot: ServerProvider;
  readonly capabilities: ProviderDelegationCapabilities;
}

const trustedRoutingContextBrand: unique symbol = Symbol("TrustedRoutingContext");

export interface TrustedRoutingContext {
  readonly [trustedRoutingContextBrand]: true;
  readonly workflow?: EngineWorkflowName | undefined;
  readonly skillOverride?: EngineDelegationSkillOverride | undefined;
}

export const makeTrustedRoutingContext = (
  input: Omit<TrustedRoutingContext, typeof trustedRoutingContextBrand>,
): TrustedRoutingContext => ({
  ...input,
  [trustedRoutingContextBrand]: true,
});

export interface EvaluateDelegationBatchInput {
  readonly routeGroupId: DelegationRouteGroupId;
  readonly tasks: ReadonlyArray<DelegationTaskSpec>;
  readonly providers: ReadonlyArray<DelegationRouterProvider>;
  readonly routerSettings: DelegationRouterSettings;
  readonly delegationSettings: EngineDelegationSettings;
  readonly trustedContext?: TrustedRoutingContext | undefined;
  readonly invokedByDelegatedChild?: boolean | undefined;
}

export interface DelegationLaneRoutingFailure {
  readonly laneId: DelegationLaneId;
  readonly reasonCode: DelegationReasonCode;
  readonly candidates: ReadonlyArray<DelegationCandidateEvaluation>;
  readonly policySource: DelegationPolicySource;
  readonly explanation: string;
}

export type DelegationBatchRoutingResult =
  | {
      readonly ok: true;
      readonly decisions: ReadonlyArray<DelegationRouteDecision>;
    }
  | {
      readonly ok: false;
      readonly failures: ReadonlyArray<DelegationLaneRoutingFailure>;
    };

interface ExpandedCandidate {
  readonly evaluation: DelegationCandidateEvaluation;
  readonly chainPosition: number;
}

const isDelegatedRunProvider = Schema.is(DelegatedRunProvider);

const stableProviderKey = (candidate: DelegationCandidateRef): string =>
  JSON.stringify([
    candidate.provider,
    candidate.providerInstanceId,
    candidate.model ?? null,
    candidate.options ?? null,
  ]);

const distinctCandidates = (
  candidates: ReadonlyArray<DelegationCandidateRef>,
): ReadonlyArray<DelegationCandidateRef> => {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = stableProviderKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const availableProviderKinds = (
  providers: ReadonlyArray<DelegationRouterProvider>,
): ReadonlySet<EngineDelegationTarget["provider"]> => {
  const available = new Set<EngineDelegationTarget["provider"]>();
  for (const provider of providers) {
    if (isDelegatedRunProvider(provider.snapshot.driver)) {
      available.add(provider.snapshot.driver);
    }
  }
  return available;
};

const baseRoutingChain = (
  input: EvaluateDelegationBatchInput,
  task: DelegationTaskSpec,
): ResolvedDelegationRoutingChain =>
  resolveDelegationRoutingChain({
    settings: input.delegationSettings,
    availableProviders: availableProviderKinds(input.providers),
    role: task.role ?? "worker",
    workflow: input.trustedContext?.workflow,
    skillOverride: input.trustedContext?.skillOverride,
  });

const constrainedRoutingChain = (
  input: EvaluateDelegationBatchInput,
  task: DelegationTaskSpec,
): ResolvedDelegationRoutingChain => {
  const base = baseRoutingChain(input, task);
  const constraint = task.providerConstraint;
  if (constraint === undefined) return base;

  let provider = constraint.provider;
  if (provider === undefined && constraint.providerInstanceId !== undefined) {
    provider = input.providers.find(
      (candidate) => candidate.snapshot.instanceId === constraint.providerInstanceId,
    )?.snapshot.driver;
  }

  const overlay = (target: EngineDelegationTarget): EngineDelegationTarget => ({
    ...target,
    ...(constraint.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: constraint.providerInstanceId }),
    ...(constraint.model === undefined ? {} : { model: constraint.model }),
    ...(constraint.options === undefined ? {} : { options: constraint.options }),
  });

  if (provider !== undefined && isDelegatedRunProvider(provider)) {
    return {
      policySource: "explicit_constraint",
      chain: [
        overlay({
          provider,
        }),
      ],
    };
  }

  return {
    policySource: "explicit_constraint",
    chain: base.chain.map(overlay),
  };
};

const unresolvedCandidateRef = (
  target: EngineDelegationTarget,
  providers: ReadonlyArray<DelegationRouterProvider>,
): DelegationCandidateRef | undefined => {
  if (target.provider === "inline") return undefined;
  const defaultInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(target.provider));
  const configuredInstances = providers
    .map((provider) => provider.snapshot)
    .filter((provider) => provider.driver === ProviderDriverKind.make(target.provider))
    .sort((left, right) =>
      left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
    );
  return {
    provider: target.provider,
    providerInstanceId:
      target.providerInstanceId ??
      configuredInstances.find((provider) => provider.instanceId === defaultInstanceId)
        ?.instanceId ??
      configuredInstances[0]?.instanceId ??
      defaultInstanceId,
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.options === undefined ? {} : { options: target.options }),
  };
};

const capabilityReasonCodes = (
  task: DelegationTaskSpec,
  capabilities: ProviderDelegationCapabilities | undefined,
): ReadonlyArray<DelegationReasonCode> => {
  if (capabilities === undefined || !capabilities.delegatedExecution) {
    return ["driver_not_delegable"];
  }
  const reasons: DelegationReasonCode[] = [];
  if ((task.attachments?.length ?? 0) > 0 && !capabilities.attachments) {
    reasons.push("missing_attachments");
  }
  if (
    task.requiredCapabilities?.structuredQuestions === true &&
    !capabilities.structuredQuestions
  ) {
    reasons.push("missing_questions");
  }
  if (task.workspaceAccess === "read-only" && !capabilities.enforcedReadOnlyWorkspace) {
    reasons.push("read_only_unenforced");
  }
  if (
    task.workspaceAccess === "workspace-write" &&
    !capabilities.workspaceWriteSandboxContainment
  ) {
    reasons.push("explicit_constraint_mismatch");
  }
  return reasons;
};

const expandCandidate = (
  input: EvaluateDelegationBatchInput,
  task: DelegationTaskSpec,
  target: EngineDelegationTarget,
  chainPosition: number,
): ExpandedCandidate | undefined => {
  const fallbackRef = unresolvedCandidateRef(target, input.providers);
  if (target.provider === "inline") return undefined;

  const resolution = resolveDelegatedProvider({
    providers: input.providers.map((candidate) => candidate.snapshot),
    provider: target.provider,
    providerInstanceId: target.providerInstanceId,
    model: target.model,
    options: target.options,
  });
  if (!resolution.ok) {
    if (fallbackRef === undefined) return undefined;
    return {
      chainPosition,
      evaluation: {
        candidate: fallbackRef,
        eligible: false,
        reasonCodes: [resolution.reasonCode],
      },
    };
  }

  const candidate: DelegationCandidateRef = {
    provider: target.provider,
    providerInstanceId: resolution.value.instance.instanceId,
    ...(resolution.value.resolvedModel === undefined
      ? {}
      : { model: resolution.value.resolvedModel }),
    ...(resolution.value.resolvedOptions === undefined
      ? {}
      : { options: resolution.value.resolvedOptions }),
  };
  const declared = input.providers.find(
    (provider) => provider.snapshot.instanceId === resolution.value.instance.instanceId,
  )?.capabilities;
  const reasonCodes = [
    ...(input.invokedByDelegatedChild === true ? (["recursion_forbidden"] as const) : []),
    ...capabilityReasonCodes(task, declared),
  ];
  return {
    chainPosition,
    evaluation: {
      candidate,
      eligible: reasonCodes.length === 0,
      reasonCodes,
    },
  };
};

const failureForLane = (
  task: DelegationTaskSpec,
  source: DelegationPolicySource,
  candidates: ReadonlyArray<ExpandedCandidate>,
  reasonCode?: DelegationReasonCode,
): DelegationLaneRoutingFailure => {
  const evaluations = candidates.map((candidate) => candidate.evaluation);
  const stableReason =
    reasonCode ??
    evaluations.find((candidate) => candidate.reasonCodes.length > 0)?.reasonCodes[0] ??
    "provider_unavailable";
  return {
    laneId: task.laneId,
    reasonCode: stableReason,
    candidates: evaluations,
    policySource: source,
    explanation: `No eligible ${task.role ?? "worker"} candidate for lane '${task.laneId}' from ${source}; first rejection: ${stableReason}.`,
  };
};

const explanationFor = (input: {
  readonly task: DelegationTaskSpec;
  readonly selected: ExpandedCandidate;
  readonly candidates: ReadonlyArray<ExpandedCandidate>;
  readonly source: DelegationPolicySource;
  readonly diversityApplied: boolean;
  readonly detail: DelegationRouterSettings["explanation"];
}): string => {
  const candidate = input.selected.evaluation.candidate;
  const base =
    `Selected ${candidate.provider}/${candidate.providerInstanceId}` +
    `${candidate.model === undefined ? "" : ` model '${candidate.model}'`}` +
    ` for ${input.task.role ?? "worker"} lane '${input.task.laneId}' from ${input.source} at chain position ${input.selected.chainPosition}.`;
  const diversity = input.diversityApplied
    ? " Diversity preference selected the first eligible unused provider."
    : "";
  if (input.detail === "summary") return `${base}${diversity}`;
  const rejected = input.candidates
    .filter((entry) => !entry.evaluation.eligible)
    .map(
      (entry) =>
        `${entry.evaluation.candidate.provider}/${entry.evaluation.candidate.providerInstanceId}=${entry.evaluation.reasonCodes.join("+")}`,
    );
  return `${base}${diversity} Eligible ${input.candidates.filter((entry) => entry.evaluation.eligible).length}/${input.candidates.length}; rejected: ${rejected.length === 0 ? "none" : rejected.join(", ")}.`;
};

const routeLane = (
  input: EvaluateDelegationBatchInput,
  task: DelegationTaskSpec,
  usedProviders: ReadonlySet<DelegationProvider>,
):
  | { readonly ok: true; readonly decision: DelegationRouteDecision }
  | { readonly ok: false; readonly failure: DelegationLaneRoutingFailure } => {
  const constrainedDriver =
    task.providerConstraint?.provider ??
    (task.providerConstraint?.providerInstanceId === undefined
      ? undefined
      : input.providers.find(
          (candidate) =>
            candidate.snapshot.instanceId === task.providerConstraint?.providerInstanceId,
        )?.snapshot.driver);
  const routing = constrainedRoutingChain(input, task);
  const candidates = routing.chain
    .map((target, index) => expandCandidate(input, task, target, index))
    .filter((candidate): candidate is ExpandedCandidate => candidate !== undefined);

  if (input.routerSettings.mode === "off") {
    return {
      ok: false,
      failure: failureForLane(task, routing.policySource, candidates, "delegation_disabled"),
    };
  }
  if (input.invokedByDelegatedChild === true) {
    return {
      ok: false,
      failure: failureForLane(task, routing.policySource, candidates, "recursion_forbidden"),
    };
  }
  if (constrainedDriver !== undefined && !isDelegatedRunProvider(constrainedDriver)) {
    return {
      ok: false,
      failure: failureForLane(task, "explicit_constraint", [], "driver_not_delegable"),
    };
  }

  const eligible = candidates.filter((candidate) => candidate.evaluation.eligible);
  if (eligible.length === 0) {
    return {
      ok: false,
      failure: failureForLane(task, routing.policySource, candidates),
    };
  }

  const first = eligible[0]!;
  const unused =
    input.routerSettings.diversity === "prefer"
      ? eligible.find((candidate) => !usedProviders.has(candidate.evaluation.candidate.provider))
      : undefined;
  const selected = unused ?? first;
  const fallbackChain =
    input.routerSettings.fallback === "pre-dispatch"
      ? distinctCandidates(
          eligible
            .filter((candidate) => candidate !== selected)
            .map((candidate) => candidate.evaluation.candidate),
        )
      : [];
  return {
    ok: true,
    decision: {
      decisionId:
        `${input.routeGroupId}:v${DELEGATION_ROUTER_POLICY_VERSION}:${task.laneId}` as DelegationRouteDecisionId,
      policyVersion: DELEGATION_ROUTER_POLICY_VERSION,
      mode: input.routerSettings.mode,
      taskKind: task.kind ?? "general",
      role: task.role ?? "worker",
      selected: selected.evaluation.candidate,
      candidates: candidates.map((candidate) => candidate.evaluation),
      fallbackChain,
      policySource: routing.policySource,
      chainPosition: selected.chainPosition,
      explanation: explanationFor({
        task,
        selected,
        candidates,
        source: routing.policySource,
        diversityApplied: selected !== first,
        detail: input.routerSettings.explanation,
      }),
    },
  };
};

/**
 * Evaluates a complete batch without reading state, reserving capacity,
 * persisting a decision, or starting a provider.
 */
export function evaluateDelegationBatch(
  input: EvaluateDelegationBatchInput,
): DelegationBatchRoutingResult {
  const indexed = input.tasks.map((task, index) => ({ task, index }));
  indexed.sort(
    (left, right) =>
      (left.task.laneId < right.task.laneId ? -1 : left.task.laneId > right.task.laneId ? 1 : 0) ||
      left.index - right.index,
  );

  const usedProviders = new Set<DelegationProvider>();
  const decisions: DelegationRouteDecision[] = [];
  const failures: DelegationLaneRoutingFailure[] = [];
  for (const { task } of indexed) {
    const result = routeLane(input, task, usedProviders);
    if (!result.ok) {
      failures.push(result.failure);
      continue;
    }
    decisions.push(result.decision);
    usedProviders.add(result.decision.selected.provider);
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true, decisions };
}

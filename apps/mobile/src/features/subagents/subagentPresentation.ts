import {
  buildSubagentInputAnswers,
  isActiveSubagentStatus,
  resolveSubagentRouteTarget,
  subagentPhaseLabel,
  type SubagentInputDraftAnswer,
} from "@t3tools/client-runtime/state/subagents";
import type { SubagentRun, UserInputQuestion } from "@t3tools/contracts";

export function mobileSubagentRunPresentation(run: SubagentRun) {
  const routeTarget = resolveSubagentRouteTarget(run);
  return {
    active: isActiveSubagentStatus(run.status),
    phaseLabel: subagentPhaseLabel(run),
    routeLabel: run.route
      ? `${run.route.role === "scout" ? "Scout" : "Worker"} · ${routeTarget ?? run.route.provider}`
      : null,
    explanation: run.route?.explanation ?? null,
    result: run.status === "failed" ? (run.error ?? run.finalMessage) : run.finalMessage,
    canCancel: run.capabilities.canCancel && isActiveSubagentStatus(run.status),
    canRespond: run.status === "waiting_for_input" && run.capabilities.canRespond,
  };
}

export function mobileSubagentStatusTone(run: SubagentRun) {
  const presentation = mobileSubagentRunPresentation(run);
  if (run.status === "failed") {
    return {
      label: presentation.phaseLabel,
      pillClassName: "bg-rose-100 dark:bg-rose-500/15",
      textClassName: "text-rose-700 dark:text-rose-300",
    };
  }
  if (run.status === "completed") {
    return {
      label: presentation.phaseLabel,
      pillClassName: "bg-emerald-100 dark:bg-emerald-500/15",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (run.status === "waiting_for_input") {
    return {
      label: presentation.phaseLabel,
      pillClassName: "bg-amber-100 dark:bg-amber-500/15",
      textClassName: "text-amber-700 dark:text-amber-300",
    };
  }
  return {
    label: presentation.phaseLabel,
    pillClassName: "bg-blue-100 dark:bg-blue-500/15",
    textClassName: "text-blue-700 dark:text-blue-300",
  };
}

export function mobileSubagentResponsePresentation(
  run: SubagentRun,
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Readonly<Record<string, SubagentInputDraftAnswer>>,
) {
  const visible = run.status === "waiting_for_input";
  const actionable = visible && run.capabilities.canRespond && questions.length > 0;
  return {
    visible,
    actionable,
    answers: actionable ? buildSubagentInputAnswers(questions, drafts) : null,
  };
}

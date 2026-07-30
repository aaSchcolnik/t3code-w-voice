import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  RouteIcon,
  ScrollTextIcon,
} from "lucide-react";
import {
  buildSubagentInputAnswers,
  setSubagentInputCustomAnswer,
  subagentRespondInput,
  type SubagentInputDraftAnswer,
} from "@t3tools/client-runtime/state/subagents";
import {
  TurnId,
  type EnvironmentId,
  type ProviderDriverKind,
  type SubagentRun,
  type SubagentRunDetails,
  type SubagentUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";

import type { SubagentEntry } from "../../session-logic";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  subagentControlInput,
  subagentRunDetailsAtomFamily,
  subagentRunDetailsInput,
  subagentsCancelRun,
  subagentsRespond,
  subagentTranscriptAtomFamily,
} from "../../state/subagents";
import { useAtomCommand } from "../../state/use-atom-command";
import { SubagentHeader } from "./SubagentHeader";
import { SubagentTimeline } from "./SubagentTimeline";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  hasDetailedSubagentTranscript,
  isActiveSubagentStatus,
  resolveSubagentRouteDiagnostics,
  subagentSummaryResult,
  subagentPhaseLabel,
} from "./subagentRunPresentation";
import {
  updateRouteDetailsCollapse,
  type RouteDetailsCollapseState,
} from "./subagentRouteCollapse";

interface SubagentTranscriptPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  run: SubagentRun;
  driverKind: ProviderDriverKind;
  providerLabel: string;
  provider?: ProviderInstanceEntry | undefined;
  accentColor?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  onBack: () => void;
}

export function SubagentRouteDetails({
  run,
  details,
  collapsed = false,
  onToggle,
}: {
  run: SubagentRun;
  details?: SubagentRunDetails | null;
  collapsed?: boolean;
  onToggle?: (() => void) | undefined;
}) {
  const diagnostics = resolveSubagentRouteDiagnostics(run, details);
  if (!diagnostics) return null;

  const model = run.resolvedModel ?? run.route?.model ?? run.requestedModel;
  const detailsId = `subagent-route-details-${run.id}`;
  return (
    <section aria-label="Delegation route details" className="border-b border-border/60 px-4 py-3">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <button
          type="button"
          className="-m-1 flex min-w-0 items-center gap-2 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          aria-controls={detailsId}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} delegation route details`}
          onClick={onToggle}
        >
          <RouteIcon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-xs font-medium text-foreground">Delegation route</h2>
          {run.route ? (
            <>
              <Badge variant="secondary">{run.route.role === "scout" ? "Scout" : "Worker"}</Badge>
              <Badge variant="outline">{run.route.providerInstanceId}</Badge>
              {model ? <Badge variant="outline">{model}</Badge> : null}
            </>
          ) : null}
          {diagnostics.policyVersion !== null ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              Policy v{diagnostics.policyVersion}
            </span>
          ) : null}
          <span className="ml-auto text-[10px] font-medium text-muted-foreground">
            {collapsed ? "Show" : "Hide"}
          </span>
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
          )}
        </button>
        {!collapsed ? (
          <div id={detailsId} className="flex flex-col gap-3">
            {diagnostics.explanation ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {diagnostics.explanation}
              </p>
            ) : null}
            {diagnostics.grouping.length > 0 ? (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                {diagnostics.grouping.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt className="text-muted-foreground">{item.label}</dt>
                    <dd
                      className="truncate font-mono text-[11px] text-foreground"
                      title={item.value}
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {diagnostics.candidates.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Candidate diagnostics
                </h3>
                {diagnostics.candidates.map((candidate) => (
                  <div
                    key={`${candidate.target}:${candidate.eligible}:${candidate.reasons.join(":")}`}
                    className="flex flex-wrap items-baseline gap-2 text-xs"
                  >
                    <Badge variant={candidate.eligible ? "success" : "secondary"}>
                      {candidate.eligible ? "Eligible" : "Excluded"}
                    </Badge>
                    <span className="font-mono text-[11px] text-foreground">
                      {candidate.target}
                    </span>
                    {candidate.reasons.length > 0 ? (
                      <span className="text-muted-foreground">{candidate.reasons.join(" · ")}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {diagnostics.fallbackChain.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Fallback chain
                </h3>
                <p className="text-xs text-muted-foreground">
                  {diagnostics.fallbackChain.join(" → ")}
                </p>
              </div>
            ) : null}
            {diagnostics.attempts.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Attempt history
                </h3>
                {diagnostics.attempts.map((attempt) => (
                  <div key={attempt.id} className="text-xs text-muted-foreground">
                    <span className="font-mono text-[11px] text-foreground">{attempt.target}</span>
                    {" · "}
                    {attempt.phase}
                    {attempt.fallbackFrom ? ` · fallback from ${attempt.fallbackFrom}` : ""}
                    {attempt.failure ? ` · ${attempt.failure}` : ""}
                  </div>
                ))}
              </div>
            ) : null}
            {diagnostics.completeness.length > 0 ? (
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {diagnostics.completeness.map((item) => (
                  <div key={item.label} className="flex items-baseline gap-1">
                    <dt className="text-muted-foreground">{item.label}:</dt>
                    <dd className="text-foreground">{item.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const scrollKeys = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

function RunSummary({
  run,
  onUserScrollPositionChange,
}: {
  run: SubagentRun;
  onUserScrollPositionChange?: ((atTop: boolean) => void) | undefined;
}) {
  const result = subagentSummaryResult(run);
  const userScrollIntent = useRef(false);
  const markUserScrollIntent = () => {
    userScrollIntent.current = true;
  };
  const markKeyboardScrollIntent = (event: KeyboardEvent<HTMLDivElement>) => {
    if (scrollKeys.has(event.key)) markUserScrollIntent();
  };
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-4"
      tabIndex={0}
      onKeyDown={markKeyboardScrollIntent}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) markUserScrollIntent();
      }}
      onTouchMove={markUserScrollIntent}
      onWheel={markUserScrollIntent}
      onScroll={(event) => {
        if (!userScrollIntent.current) return;
        onUserScrollPositionChange?.(event.currentTarget.scrollTop <= 1);
      }}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex items-center gap-2">
          <ScrollTextIcon className="size-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            {subagentPhaseLabel(run)}
          </span>
        </div>
        <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Task
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {run.taskPreview}
          </p>
        </section>
        {result ? (
          <section className="rounded-xl border border-border/60 p-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {run.status === "failed" ? "Error" : "Result"}
            </h2>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {result}
            </p>
          </section>
        ) : isActiveSubagentStatus(run.status) ? (
          <p className="text-xs text-muted-foreground">The subagent is still working.</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This provider did not report a result or detailed activity for this run.
          </p>
        )}
      </div>
    </div>
  );
}

export function SubagentInputResponseForm({
  run,
  details,
  onSubmit,
}: {
  run: SubagentRun;
  details?: SubagentRunDetails | null;
  onSubmit: (answers: SubagentUserInputAnswers) => Promise<unknown>;
}) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, SubagentInputDraftAnswer>>>({});
  const [submitting, setSubmitting] = useState(false);
  const questions = details?.pendingQuestions ?? [];
  const answers = buildSubagentInputAnswers(questions, drafts);

  if (
    run.status !== "waiting_for_input" ||
    !run.capabilities.canRespond ||
    questions.length === 0
  ) {
    return null;
  }

  return (
    <section aria-label="Subagent input response" className="border-b border-border/60 px-4 py-3">
      <form
        className="mx-auto flex max-w-2xl flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!answers) return;
          setSubmitting(true);
          void onSubmit(answers).finally(() => setSubmitting(false));
        }}
      >
        <div>
          <h2 className="text-sm font-medium text-foreground">Input required</h2>
          <p className="text-xs text-muted-foreground">
            Answer the child run’s server-authored questions.
          </p>
        </div>
        <FieldGroup>
          {questions.map((question) => {
            const draft = drafts[question.id];
            const customAnswer = draft?.customAnswer ?? "";
            const selected = customAnswer.trim().length
              ? []
              : [...(draft?.selectedOptionLabels ?? [])];
            const inputId = `subagent-answer-${run.id}-${question.id}`;
            return (
              <Field key={question.id}>
                <FieldLabel htmlFor={inputId}>{question.header}</FieldLabel>
                <FieldDescription>{question.question}</FieldDescription>
                {question.multiSelect ? (
                  <FieldDescription>Select one or more options.</FieldDescription>
                ) : null}
                {question.options.length > 0 ? (
                  <ToggleGroup
                    aria-label={`${question.header} options`}
                    className="flex-wrap"
                    size="sm"
                    variant="outline"
                    value={selected}
                    onValueChange={(values) =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: {
                          customAnswer: "",
                          ...(values.length
                            ? {
                                selectedOptionLabels: question.multiSelect
                                  ? values
                                  : values.slice(-1),
                              }
                            : {}),
                        },
                      }))
                    }
                  >
                    {question.options.map((option) => (
                      <Toggle
                        key={option.label}
                        aria-label={`${option.label}: ${option.description}`}
                        value={option.label}
                      >
                        {option.label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                ) : null}
                <Textarea
                  id={inputId}
                  aria-label={`${question.header} custom answer`}
                  disabled={submitting}
                  placeholder="Or type a custom answer"
                  value={customAnswer}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [question.id]: setSubagentInputCustomAnswer(
                        current[question.id],
                        event.target.value,
                      ),
                    }))
                  }
                />
              </Field>
            );
          })}
        </FieldGroup>
        <Button className="self-start" disabled={!answers || submitting} type="submit">
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          {submitting ? "Submitting…" : "Submit answers"}
        </Button>
      </form>
    </section>
  );
}

function toTimelineEntry(run: SubagentRun): SubagentEntry {
  const active = isActiveSubagentStatus(run.status);
  return {
    id: run.id,
    name: run.title,
    lastMessage: run.lastSummary,
    status: active ? "active" : "done",
    outcome: active
      ? null
      : run.status === "failed"
        ? "failed"
        : run.status === "cancelled"
          ? "stopped"
          : "completed",
    turnId: run.rootTurnId ? TurnId.make(run.rootTurnId) : null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    providerInstanceId: run.providerInstanceId,
    source: run.source,
    providerDriver: run.provider,
    model: run.resolvedModel ?? run.requestedModel ?? null,
    reasoningEffort: null,
    agentType: run.agentType ?? null,
    transcriptId: run.id,
    requestedOptions: run.requestedOptions,
    resolvedOptions: run.resolvedOptions,
    resolvedOptionDetails: run.resolvedOptionDetails,
  };
}

export function SubagentTranscriptPanel({
  environmentId,
  threadId,
  run,
  driverKind,
  providerLabel,
  provider,
  accentColor,
  cwd,
  workspaceRoot,
  onBack,
}: SubagentTranscriptPanelProps) {
  const [cancelling, setCancelling] = useState(false);
  const [routeCollapse, setRouteCollapse] = useState<RouteDetailsCollapseState>({
    manual: false,
    automatic: false,
  });
  const cancelRun = useAtomCommand(subagentsCancelRun, { label: "subagents cancel run" });
  const respondRun = useAtomCommand(subagentsRespond, { label: "subagents respond" });
  const detailsAtom = useMemo(
    () =>
      subagentRunDetailsAtomFamily({
        environmentId,
        input: subagentRunDetailsInput(threadId, run.id),
      }),
    [environmentId, run.id, threadId],
  );
  const detailsResult = useAtomValue(detailsAtom);
  const details = Option.getOrNull(AsyncResult.value(detailsResult));
  const transcriptAtom = useMemo(
    () =>
      hasDetailedSubagentTranscript(run.capabilities.transcriptQuality)
        ? subagentTranscriptAtomFamily({
            environmentId,
            input: { rootThreadId: threadId, runId: run.id },
          })
        : null,
    [environmentId, run.capabilities.transcriptQuality, run.id, threadId],
  );
  useEffect(() => {
    setRouteCollapse((current) => updateRouteDetailsCollapse(current, { type: "reset" }));
  }, [run.id]);
  const routeCollapsed = routeCollapse.manual || routeCollapse.automatic;
  const toggleRoute = useCallback(() => {
    setRouteCollapse((current) => updateRouteDetailsCollapse(current, { type: "toggle" }));
  }, []);
  const onUserScrollPositionChange = useCallback((atTop: boolean) => {
    setRouteCollapse((current) =>
      updateRouteDetailsCollapse(current, { type: "user-scroll", atTop }),
    );
  }, []);

  const onCancel =
    run.capabilities.canCancel && isActiveSubagentStatus(run.status)
      ? () => {
          setCancelling(true);
          void cancelRun({
            environmentId,
            input: subagentControlInput(threadId, run),
          }).finally(() => setCancelling(false));
        }
      : undefined;
  const header = (
    <SubagentHeader
      run={run}
      driverKind={driverKind}
      providerLabel={providerLabel}
      provider={provider}
      accentColor={accentColor}
      onBack={onBack}
      onCancel={onCancel}
      cancelling={cancelling}
    />
  );
  const inputResponse = (
    <SubagentInputResponseForm
      run={run}
      details={details}
      onSubmit={(answers) =>
        respondRun({
          environmentId,
          input: subagentRespondInput(threadId, run, answers),
        }).then(() => undefined)
      }
    />
  );

  if (!transcriptAtom) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {inputResponse}
        <SubagentRouteDetails
          run={run}
          details={details}
          collapsed={routeCollapsed}
          onToggle={toggleRoute}
        />
        <RunSummary run={run} onUserScrollPositionChange={onUserScrollPositionChange} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {inputResponse}
      <SubagentRouteDetails
        run={run}
        details={details}
        collapsed={routeCollapsed}
        onToggle={toggleRoute}
      />
      <SubagentTranscriptBody
        atom={transcriptAtom}
        run={run}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
        onUserScrollPositionChange={onUserScrollPositionChange}
      />
    </div>
  );
}

function SubagentTranscriptBody({
  atom,
  run,
  cwd,
  workspaceRoot,
  onUserScrollPositionChange,
}: {
  atom: NonNullable<ReturnType<typeof subagentTranscriptAtomFamily>>;
  run: SubagentRun;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  onUserScrollPositionChange?: ((atTop: boolean) => void) | undefined;
}) {
  const result = useAtomValue(atom);

  if (AsyncResult.isFailure(result)) {
    return <RunSummary run={run} onUserScrollPositionChange={onUserScrollPositionChange} />;
  }
  if (!AsyncResult.isSuccess(result)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleDashedIcon className="size-4" aria-hidden />
          Loading transcript
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1">
      <SubagentTimeline
        transcript={result.value}
        entry={toTimelineEntry(run)}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
        onUserScrollPositionChange={onUserScrollPositionChange}
      />
    </div>
  );
}

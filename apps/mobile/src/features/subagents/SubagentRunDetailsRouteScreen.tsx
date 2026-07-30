import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, SubagentRunId, ThreadId, type SubagentRun } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  resolveSubagentRouteDiagnostics,
  setSubagentInputCustomAnswer,
  subagentControlInput,
  subagentRespondInput,
  toggleSubagentInputOption,
  type SubagentInputDraftAnswer,
} from "@t3tools/client-runtime/state/subagents";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { selectSubagentRun } from "../../state/subagentSelection";
import { subagentEnvironment, useSubagentRuns } from "../../state/subagents";
import {
  mobileSubagentResponsePresentation,
  mobileSubagentRunPresentation,
  mobileSubagentStatusTone,
} from "./subagentPresentation";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly runId: string;
}>;

function DetailSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2 rounded-[22px] border border-border bg-card p-4">
      <Text className="font-t3-bold text-sm uppercase tracking-[1px] text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function DiagnosticLine(props: {
  readonly title: string;
  readonly detail?: string | null;
  readonly tone?: "default" | "success" | "warning";
}) {
  const tone =
    props.tone === "success"
      ? "text-emerald-700 dark:text-emerald-300"
      : props.tone === "warning"
        ? "text-amber-700 dark:text-amber-300"
        : "text-foreground";
  return (
    <View className="gap-0.5">
      <Text className={`font-t3-bold text-sm ${tone}`}>{props.title}</Text>
      {props.detail ? (
        <Text className="text-sm leading-normal text-foreground-muted">{props.detail}</Text>
      ) : null}
    </View>
  );
}

export function SubagentRunDetailsRouteScreen({ route }: Props) {
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const runId = SubagentRunId.make(route.params.runId);
  const state = useSubagentRuns(environmentId, threadId);
  const run = selectSubagentRun(state.runs, runId);
  const detailsAtom = useMemo(
    () =>
      subagentEnvironment.runDetails({
        environmentId,
        input: { rootThreadId: threadId, runId },
      }),
    [environmentId, runId, threadId],
  );
  const details = useEnvironmentQuery(detailsAtom);
  const cancelRun = useAtomCommand(subagentEnvironment.cancelRun, "subagent cancellation");
  const respondRun = useAtomCommand(subagentEnvironment.respondRun, "subagent response");
  const [cancelling, setCancelling] = useState(false);
  const [responding, setResponding] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState<
    Readonly<Record<string, SubagentInputDraftAnswer>>
  >({});

  if (state.authoritative && run === null) {
    return (
      <View className="flex-1 justify-center bg-sheet px-5">
        <EmptyState
          title="Run unavailable"
          detail="The server no longer includes this run in the thread snapshot."
        />
      </View>
    );
  }
  if (run === null) {
    return <View className="flex-1 bg-sheet" />;
  }

  const presentation = mobileSubagentRunPresentation(run);
  const diagnostics = resolveSubagentRouteDiagnostics(run, details.data);
  const pendingQuestions = details.data?.pendingQuestions ?? [];
  const responsePresentation = mobileSubagentResponsePresentation(
    run,
    pendingQuestions,
    draftAnswers,
  );
  const answers = responsePresentation.answers;

  const confirmCancellation = () => {
    Alert.alert("Cancel delegated run?", "The environment is authoritative for cancellation.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Cancel run",
        style: "destructive",
        onPress: async () => {
          setCancelling(true);
          await cancelRun({
            environmentId,
            input: subagentControlInput(threadId, run),
          });
          setCancelling(false);
        },
      },
    ]);
  };

  const submitResponse = async () => {
    if (!answers) return;
    setResponding(true);
    await respondRun({
      environmentId,
      input: subagentRespondInput(threadId, run, answers),
    });
    setResponding(false);
  };

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
          <View className="flex-row items-start gap-3">
            <Text className="min-w-0 flex-1 font-t3-bold text-xl text-foreground">{run.title}</Text>
            <StatusPill size="compact" {...mobileSubagentStatusTone(run)} />
          </View>
          <Text className="text-sm leading-normal text-foreground-muted">{run.taskPreview}</Text>
          {presentation.routeLabel ? (
            <Text className="font-t3-bold text-sm text-foreground">{presentation.routeLabel}</Text>
          ) : null}
        </View>

        {run.status === "waiting_for_input" ? (
          <DetailSection title="Input required">
            {responsePresentation.actionable ? (
              <>
                {pendingQuestions.map((question) => {
                  const draft = draftAnswers[question.id];
                  const selected = draft?.customAnswer?.trim()
                    ? []
                    : (draft?.selectedOptionLabels ?? []);
                  return (
                    <View key={question.id} className="gap-2">
                      <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted">
                        {question.header}
                      </Text>
                      <Text className="text-base leading-snug text-foreground">
                        {question.question}
                      </Text>
                      {question.multiSelect ? (
                        <Text className="text-xs text-foreground-muted">
                          Select one or more options.
                        </Text>
                      ) : null}
                      <View className="flex-row flex-wrap gap-2">
                        {question.options.map((option) => {
                          const isSelected = selected.includes(option.label);
                          return (
                            <Pressable
                              key={option.label}
                              accessibilityRole="button"
                              accessibilityState={{ selected: isSelected }}
                              className={cn(
                                "rounded-full border px-3 py-2.5",
                                isSelected
                                  ? "border-primary bg-primary/10"
                                  : "border-border bg-sheet",
                              )}
                              onPress={() =>
                                setDraftAnswers((current) => ({
                                  ...current,
                                  [question.id]: toggleSubagentInputOption(
                                    question,
                                    current[question.id],
                                    option.label,
                                  ),
                                }))
                              }
                            >
                              <Text
                                className={cn(
                                  "font-t3-bold text-sm",
                                  isSelected ? "text-primary" : "text-foreground",
                                )}
                              >
                                {option.label}
                              </Text>
                              <Text className="mt-0.5 text-xs text-foreground-muted">
                                {option.description}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      <TextInput
                        accessibilityLabel={`${question.header} custom answer`}
                        value={draft?.customAnswer ?? ""}
                        onChangeText={(value) =>
                          setDraftAnswers((current) => ({
                            ...current,
                            [question.id]: setSubagentInputCustomAnswer(
                              current[question.id],
                              value,
                            ),
                          }))
                        }
                        placeholder="Or type a custom answer"
                      />
                    </View>
                  );
                })}
                <ActionButton
                  disabled={!answers || responding}
                  label={responding ? "Submitting…" : "Submit answers"}
                  onPress={() => void submitResponse()}
                />
              </>
            ) : (
              <Text className="text-sm leading-normal text-foreground-muted">
                {presentation.canRespond
                  ? details.isPending
                    ? "Loading the server-authored questions…"
                    : "The pending questions are no longer available."
                  : "The server reports that this run cannot accept a response."}
              </Text>
            )}
          </DetailSection>
        ) : null}

        {diagnostics ? (
          <DetailSection title="Route decision">
            {diagnostics.explanation ? (
              <Text className="text-sm leading-normal text-foreground">
                {diagnostics.explanation}
              </Text>
            ) : null}
            {diagnostics.policyVersion !== null ? (
              <Text className="text-xs text-foreground-muted">
                Policy version {diagnostics.policyVersion}
              </Text>
            ) : null}
          </DetailSection>
        ) : null}

        {details.error ? <ErrorBanner message={details.error} /> : null}
        {details.isPending && details.data === null ? (
          <Text className="px-2 text-sm text-foreground-muted">Loading server diagnostics…</Text>
        ) : null}

        {diagnostics?.candidates.length ? (
          <DetailSection title="Candidates">
            {diagnostics.candidates.map((candidate) => (
              <DiagnosticLine
                key={candidate.target}
                title={`${candidate.eligible ? "Eligible" : "Excluded"} · ${candidate.target}`}
                detail={candidate.reasons.join(" · ")}
                tone={candidate.eligible ? "success" : "warning"}
              />
            ))}
          </DetailSection>
        ) : null}

        {diagnostics?.fallbackChain.length ? (
          <DetailSection title="Fallback order">
            {diagnostics.fallbackChain.map((target, index) => (
              <DiagnosticLine key={target} title={`${index + 1}. ${target}`} />
            ))}
          </DetailSection>
        ) : null}

        {diagnostics?.attempts.length ? (
          <DetailSection title="Attempts">
            {diagnostics.attempts.map((attempt) => (
              <DiagnosticLine
                key={attempt.id}
                title={`${attempt.target} · ${attempt.phase}`}
                detail={[
                  attempt.fallbackFrom ? `Fallback from ${attempt.fallbackFrom}` : null,
                  attempt.failure,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                tone={attempt.failure ? "warning" : "default"}
              />
            ))}
          </DetailSection>
        ) : null}

        <RunResult run={run} />

        {presentation.canCancel ? (
          <ActionButton
            destructive
            disabled={cancelling}
            label={cancelling ? "Cancelling…" : "Cancel run"}
            onPress={confirmCancellation}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function RunResult({ run }: { readonly run: SubagentRun }) {
  const result = mobileSubagentRunPresentation(run).result;
  if (!result && run.resultCompleteness === undefined) return null;
  const completeness =
    run.resultCompleteness === "terminal_message"
      ? "Terminal message"
      : run.resultCompleteness === "partial"
        ? "Partial result"
        : run.resultCompleteness === "none"
          ? "No result"
          : null;
  return (
    <DetailSection title="Result">
      {result ? <Text className="text-sm leading-normal text-foreground">{result}</Text> : null}
      {completeness ? (
        <Text className="text-xs text-foreground-muted">
          {completeness}
          {run.terminalEventSeen === false ? " · terminal event not seen" : ""}
        </Text>
      ) : null}
    </DetailSection>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={
        props.destructive
          ? "items-center rounded-2xl bg-rose-600 px-4 py-3.5 active:opacity-70"
          : "items-center rounded-2xl bg-primary px-4 py-3.5 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text className="font-t3-bold text-sm text-white">{props.label}</Text>
    </Pressable>
  );
}

import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { useSubagentRuns } from "../../state/subagents";
import { mobileSubagentRunPresentation, mobileSubagentStatusTone } from "./subagentPresentation";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function SubagentRunsRouteScreen({ route }: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const state = useSubagentRuns(environmentId, threadId);

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {state.error ? (
          <EmptyState
            title="Runs unavailable"
            detail="The environment could not load its authoritative delegated-run state."
          />
        ) : !state.authoritative ? (
          <Text className="px-2 text-sm text-foreground-muted">Loading delegated runs…</Text>
        ) : state.runs.length === 0 ? (
          <EmptyState
            title="No delegated runs"
            detail="Routed and native subagent work for this thread will appear here."
          />
        ) : (
          state.runs.map((run) => {
            const presentation = mobileSubagentRunPresentation(run);
            return (
              <Pressable
                key={run.id}
                accessibilityLabel={`Open ${run.title}`}
                accessibilityRole="button"
                className="gap-2.5 rounded-[22px] border border-border bg-card p-4 active:opacity-70"
                onPress={() =>
                  navigation.navigate("SubagentRunDetails", {
                    environmentId: String(environmentId),
                    threadId: String(threadId),
                    runId: String(run.id),
                  })
                }
              >
                <View className="flex-row items-start gap-3">
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="font-t3-bold text-lg text-foreground" numberOfLines={2}>
                      {run.title}
                    </Text>
                    {presentation.routeLabel ? (
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {presentation.routeLabel}
                      </Text>
                    ) : null}
                  </View>
                  <StatusPill size="compact" {...mobileSubagentStatusTone(run)} />
                </View>
                {presentation.explanation ? (
                  <Text className="text-sm leading-normal text-foreground-muted" numberOfLines={3}>
                    {presentation.explanation}
                  </Text>
                ) : null}
                {run.status === "waiting_for_input" ? (
                  <Text className="font-t3-bold text-sm text-amber-700 dark:text-amber-300">
                    {run.capabilities.canRespond
                      ? "Input required · child response RPC unavailable on mobile"
                      : "Input required · server reports this run cannot respond"}
                  </Text>
                ) : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

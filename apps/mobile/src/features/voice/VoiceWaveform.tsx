import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

const WAVEFORM_BAR_IDS = Array.from({ length: 32 }, (_, index) => `voice-level-${index}`);

export const VoiceWaveform = memo(function VoiceWaveform(props: {
  readonly levels: ReadonlyArray<number>;
  readonly transcript: string;
  readonly state: "starting" | "recording" | "stopping";
}) {
  const levels =
    props.levels.length > 0
      ? props.levels.slice(-24)
      : Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? 0.18 : 0.08));
  const status =
    props.state === "starting"
      ? "Starting microphone…"
      : props.state === "stopping"
        ? "Finishing transcription…"
        : props.transcript || "Listening…";

  return (
    <View accessibilityLabel={status} className="mb-2.5 gap-2 rounded-2xl bg-subtle px-3 py-2.5">
      <View className="h-6 flex-row items-center justify-center gap-0.5 overflow-hidden">
        {levels.map((level, index) => (
          <View
            key={WAVEFORM_BAR_IDS[index]}
            className="w-1 rounded-full bg-primary"
            style={{ height: Math.max(3, Math.round(level * 24)) }}
          />
        ))}
      </View>
      <Text className="text-center text-xs text-foreground-muted" numberOfLines={2}>
        {status}
      </Text>
    </View>
  );
});

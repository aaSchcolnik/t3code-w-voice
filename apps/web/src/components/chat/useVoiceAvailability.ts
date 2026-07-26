import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { inspectLocalVoiceCapability } from "~/voice/transcriberFactory";

export interface VoiceAvailability {
  readonly available: boolean;
  readonly localPresent: boolean;
  readonly serverEnabled: boolean;
}

export function computeVoiceAvailability(input: {
  readonly serverEnabled: boolean;
  readonly localPresent: boolean;
  readonly mode: "auto" | "local" | "server";
  readonly canOnboardLocal?: boolean;
}): VoiceAvailability {
  return {
    serverEnabled: input.serverEnabled,
    localPresent: input.localPresent,
    available:
      input.serverEnabled ||
      ((input.localPresent || input.canOnboardLocal === true) && input.mode !== "server"),
  };
}

export function useVoiceAvailability(environmentId: EnvironmentId): VoiceAvailability {
  const settings = useEnvironmentSettings(environmentId);
  const [localPresent, setLocalPresent] = useState(false);

  useEffect(() => {
    let disposed = false;
    const bridge = window.desktopBridge;
    const refresh = () => {
      void inspectLocalVoiceCapability(
        bridge,
        settings.voiceModelId,
        settings.voiceModelQuant,
      ).then((capability) => {
        if (!disposed) setLocalPresent(capability.present);
      });
    };
    refresh();
    const unsubscribe = bridge?.voiceModels?.onDownloadProgress(refresh);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [settings.voiceModelId, settings.voiceModelQuant]);

  return useMemo(
    () =>
      computeVoiceAvailability({
        serverEnabled: settings.voice.enabled,
        localPresent,
        mode: settings.voiceInferenceMode,
        canOnboardLocal: Boolean(
          window.desktopBridge?.transcription && window.desktopBridge.voiceModels,
        ),
      }),
    [localPresent, settings.voice.enabled, settings.voiceInferenceMode],
  );
}

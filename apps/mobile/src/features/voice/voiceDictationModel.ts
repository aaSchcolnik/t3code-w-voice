import type { VoiceDictionaryEntry } from "@t3tools/contracts";
import { applyAliases, voicePromptTerms } from "@t3tools/voice-core";

export function renderMobileTranscript(segments: ReadonlyMap<number, string>): string {
  return [...segments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function renderCommittedMobileTranscript(
  segments: ReadonlyMap<number, string>,
  dictionary: ReadonlyArray<VoiceDictionaryEntry>,
): string {
  return applyAliases(renderMobileTranscript(segments), dictionary, {
    promptedTerms: voicePromptTerms(dictionary),
  });
}

export function buildMobileVoicePrompt(
  dictionary: ReadonlyArray<VoiceDictionaryEntry>,
): string | undefined {
  const prompt = voicePromptTerms(dictionary).join(", ").slice(0, 600).trim();
  return prompt || undefined;
}

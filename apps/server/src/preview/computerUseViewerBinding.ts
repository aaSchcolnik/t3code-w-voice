import * as Schema from "effect/Schema";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";

const PREFIX = "computer-use-viewer:v1:";
const Binding = Schema.Struct({
  sessionId: Schema.String,
  threadId: Schema.String,
  parentAuthSessionId: Schema.String,
});
export type ComputerUseViewerBinding = typeof Binding.Type;
const decodeBinding = Schema.decodeUnknownOption(Schema.fromJsonString(Binding));

// This subject is part of the server-issued, authenticated viewer session.
// Persisting the binding here preserves source restrictions across restarts.
export function makeComputerUseViewerSubject(binding: ComputerUseViewerBinding): string {
  return PREFIX + base64UrlEncode(JSON.stringify(binding));
}
export function parseComputerUseViewerSubject(subject: string): ComputerUseViewerBinding | null {
  if (!subject.startsWith(PREFIX)) return null;
  try {
    const result = decodeBinding(base64UrlDecodeUtf8(subject.slice(PREFIX.length)));
    return result._tag === "Some" ? result.value : null;
  } catch {
    return null;
  }
}
export function isComputerUseViewerSubject(subject: string): boolean {
  return subject.startsWith(PREFIX);
}

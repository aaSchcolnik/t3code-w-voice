const ESC = "\u001b";
const BEL = "\u0007";
const MAX_PENDING_ESCAPE_CHARS = 4_096;

const SAFE_CSI_FINALS = new Set([
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "S",
  "T",
  "f",
  "m",
  "s",
  "u",
]);

/**
 * Stateful sanitizer for bytes replayed into a readonly terminal surface.
 * It preserves ordinary text and a small CSI allowlist while removing OSC,
 * DCS, device controls, NULs, and incomplete escape sequences across chunks.
 */
export class TerminalReplaySanitizer {
  private pending = "";

  push(chunk: string, final = false): string {
    const input = this.pending + chunk;
    this.pending = "";
    let output = "";

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index] ?? "";
      if (char === ESC) {
        const kind = input[index + 1];
        if (kind === undefined) {
          if (!final) this.pending = ESC;
          break;
        }
        if (kind === "]" || kind === "P" || kind === "^" || kind === "_") {
          let cursor = index + 2;
          let terminated = false;
          while (cursor < input.length) {
            if (input[cursor] === BEL) {
              terminated = true;
              cursor += 1;
              break;
            }
            if (input[cursor] === ESC && input[cursor + 1] === "\\") {
              terminated = true;
              cursor += 2;
              break;
            }
            cursor += 1;
          }
          if (!terminated && !final) {
            const pending = input.slice(index);
            this.pending = pending.length <= MAX_PENDING_ESCAPE_CHARS ? pending : "";
            break;
          }
          index = cursor - 1;
          continue;
        }
        if (kind === "[") {
          let cursor = index + 2;
          while (cursor < input.length && !/[\x40-\x7e]/.test(input[cursor] ?? "")) {
            cursor += 1;
          }
          if (cursor >= input.length) {
            if (!final) {
              const pending = input.slice(index);
              this.pending = pending.length <= MAX_PENDING_ESCAPE_CHARS ? pending : "";
            }
            break;
          }
          const finalChar = input[cursor] ?? "";
          if (SAFE_CSI_FINALS.has(finalChar)) {
            output += input.slice(index, cursor + 1);
          }
          index = cursor;
          continue;
        }
        index += 1;
        continue;
      }
      const code = char.charCodeAt(0);
      if (
        code === 0 ||
        (code < 32 && char !== "\n" && char !== "\r" && char !== "\t" && char !== "\b")
      ) {
        continue;
      }
      output += char;
    }
    return output;
  }
}

/** Plain-text form used in provider prompts and mobile rendering. */
export function sanitizeTerminalCommandPlainText(value: string): string {
  const replay = new TerminalReplaySanitizer();
  return replay
    .push(value, true)
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

export function escapeTerminalCommandXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

import type { TerminalCommandRecord } from "@t3tools/contracts";

// Terminal escape sequences intentionally match control characters.
const TERMINAL_ANSI_PATTERN =
  // eslint-disable-next-line eslint/no-control-regex
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P.*?\u001b\\)/gs;

export function terminalCommandPlainText(value: string): string {
  return value.replace(TERMINAL_ANSI_PATTERN, "").replaceAll("\u0000", "");
}

export function terminalCommandLines(command: string): string[] {
  return command.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export function terminalCommandDisplayLines(
  command: string,
  limit: number,
): ReadonlyArray<{ readonly key: string; readonly text: string }> {
  const occurrences = new Map<string, number>();
  return terminalCommandLines(command)
    .slice(0, limit)
    .map((text) => {
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      return { key: `${text}:${occurrence}`, text };
    });
}

export function terminalCommandStatusText(record: TerminalCommandRecord): string {
  const duration = record.durationMs > 0 ? ` · ${(record.durationMs / 1_000).toFixed(1)}s` : "";
  if (record.status === "completed") return `exit 0${duration}`;
  if (record.status === "failed") {
    return record.exitCode === null
      ? `failed to start${duration}`
      : `exit ${record.exitCode}${duration}`;
  }
  return `${record.status.replaceAll("_", " ")}${duration}`;
}

export function terminalCommandCopyText(
  record: TerminalCommandRecord,
  output: string = record.excerpt,
): string {
  const commands = terminalCommandLines(record.command)
    .map((line) => `$ ${line}`)
    .join("\n");
  const plainOutput = terminalCommandPlainText(output).replace(/(?:\r?\n)+$/, "");
  return [commands, plainOutput, terminalCommandStatusText(record)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

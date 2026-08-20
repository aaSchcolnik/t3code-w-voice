import type { EnvironmentId, TerminalCommandRecord, ThreadId } from "@t3tools/contracts";
import {
  terminalCommandCopyText,
  terminalCommandDisplayLines,
  terminalCommandLines,
  terminalCommandStatusText,
} from "@t3tools/client-runtime/terminal-command-text";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ChevronDownIcon, SquareIcon, TerminalIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  terminalFontOptions,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { terminalEnvironment } from "../../state/terminal";
import { useAttachedTerminalCommand } from "../../state/terminalCommands";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { terminalThemeFromApp } from "../../terminal/ghostty/theme";
import { Button } from "../ui/button";
import { MessageCopyButton } from "./MessageCopyButton";

/** Hard cap on the output viewport; longer output scrolls inside the surface. */
const MAX_SURFACE_HEIGHT = 208;

const MAX_COMMAND_HEADER_LINES = 4;

/** Trailing newlines would park the cursor on a blank row below the content,
 * which a content-sized viewport would then show instead of the output. */
function trimTrailingNewlines(output: string): string {
  return output.replace(/(?:\r?\n)+$/, "");
}

/** Rows the trimmed output occupies; a one-liner stays one row tall. */
function countOutputRows(output: string): number {
  if (output.length === 0) return 1;
  let rows = 1;
  for (let index = 0; index < output.length; index++) {
    if (output.charCodeAt(index) === 10) rows++;
  }
  return rows;
}

function ReadonlyTerminalSurface({
  output,
  fontFamily,
  fontSize,
}: {
  readonly output: string;
  readonly fontFamily: string;
  readonly fontSize: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const fontRef = useRef({ family: fontFamily, size: fontSize });
  fontRef.current = { family: fontFamily, size: fontSize };
  const trimmedOutput = trimTrailingNewlines(output);
  const outputRef = useRef(trimmedOutput);
  outputRef.current = trimmedOutput;
  const [surfaceHeight, setSurfaceHeight] = useState<number | null>(null);

  const rows = countOutputRows(trimmedOutput);
  const applyContentHeight = useEffectEvent((terminal: GhosttyTerminalSurface) => {
    setSurfaceHeight(
      Math.min(terminal.contentHeightForRows(terminal.contentRowCount()), MAX_SURFACE_HEIGHT),
    );
  });

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let themeObserver: MutationObserver | null = null;
    const setupFont = fontRef.current;
    void GhosttyTerminalSurface.create(mount, {
      readonly: true,
      theme: terminalThemeFromApp(mount),
      font: terminalFontOptions(setupFont.family, setupFont.size),
      onData: () => {},
      onResize: () => {},
      onSelectionChange: () => {},
      beforeKey: () => true,
      onLinkActivate: () => {},
    }).then((terminal) => {
      if (cancelled) {
        terminal.dispose();
        return;
      }
      terminalRef.current = terminal;
      // The theme observer is not installed yet, so re-read the theme in case
      // the app toggled light/dark while the WASM surface was loading.
      terminal.setTheme(terminalThemeFromApp(mount));
      // Client settings hydrate asynchronously; re-apply whatever is current
      // in case a font preference landed while the surface was loading.
      const currentFont = fontRef.current;
      const fontSettled =
        currentFont.family === setupFont.family && currentFont.size === setupFont.size
          ? Promise.resolve()
          : terminal.setFont(terminalFontOptions(currentFont.family, currentFont.size));
      void fontSettled.then(() => {
        if (terminalRef.current !== terminal) return;
        terminal.resetAndWrite(outputRef.current);
        applyContentHeight(terminal);
      });
      themeObserver = new MutationObserver(() => {
        terminalRef.current?.setTheme(terminalThemeFromApp(mount));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    });
    return () => {
      cancelled = true;
      themeObserver?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.resetAndWrite(trimmedOutput);
    applyContentHeight(terminal);
  }, [trimmedOutput]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    void terminal.setFont(terminalFontOptions(fontFamily, fontSize)).then(() => {
      if (terminalRef.current !== terminal) return;
      applyContentHeight(terminal);
    });
  }, [fontFamily, fontSize]);

  // Estimate until the surface reports real cell metrics, so a one-line result
  // never flashes at full height.
  const estimatedHeight = Math.min(rows * Math.ceil(fontSize * 1.5) + 8, MAX_SURFACE_HEIGHT);
  return (
    <div
      ref={mountRef}
      className="relative min-w-0 overflow-hidden"
      style={{
        height: surfaceHeight ?? estimatedHeight,
        backgroundColor: "var(--terminal-background, var(--background))",
      }}
    />
  );
}

export function TerminalCommandRow({
  environmentId,
  threadId,
  record: persistedRecord,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly record: TerminalCommandRecord;
}) {
  const attached = useAttachedTerminalCommand({
    environmentId,
    execution:
      persistedRecord.status === "queued" || persistedRecord.status === "running"
        ? { threadId, executionId: persistedRecord.executionId }
        : null,
  });
  const cancel = useAtomCommand(terminalEnvironment.execCancel, { reportFailure: false });
  const readOutput = useAtomCommand(terminalEnvironment.execReadOutput, { reportFailure: false });
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const retainedOutputRef = useRef<string | null>(null);
  const retainedOutputPromiseRef = useRef<Promise<string | null> | null>(null);
  const [loadingFullOutput, setLoadingFullOutput] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const terminalFontFamily = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: advancedTypography,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const terminalFontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const record = attached.record ?? persistedRecord;
  const output = fullOutput ?? (attached.output || record.excerpt);
  const active = record.status === "queued" || record.status === "running";
  const commandLines = terminalCommandLines(record.command);
  const visibleCommandLines = terminalCommandDisplayLines(record.command, MAX_COMMAND_HEADER_LINES);
  const hiddenCommandLineCount = commandLines.length - visibleCommandLines.length;

  const fetchFullOutput = async (): Promise<string | null> => {
    if (retainedOutputRef.current !== null) return retainedOutputRef.current;
    if (retainedOutputPromiseRef.current !== null) return retainedOutputPromiseRef.current;
    const request = (async () => {
      let offset = 0;
      let collected = "";
      while (true) {
        const result = await readOutput({
          environmentId,
          input: { threadId, executionId: record.executionId, offset },
        });
        if (result._tag !== "Success") return null;
        collected += result.value.data;
        if (result.value.eof || result.value.nextOffset <= offset) break;
        offset = result.value.nextOffset;
      }
      retainedOutputRef.current = collected;
      return collected;
    })();
    retainedOutputPromiseRef.current = request;
    try {
      return await request;
    } finally {
      retainedOutputPromiseRef.current = null;
    }
  };

  const loadFullOutput = async () => {
    if (fullOutput !== null) {
      setFullOutput(null);
      return;
    }
    setLoadingFullOutput(true);
    const retainedOutput = await fetchFullOutput();
    if (retainedOutput !== null) setFullOutput(retainedOutput);
    setLoadingFullOutput(false);
  };

  const copyTerminalBlock = async () => {
    const retainedOutput = record.truncated ? await fetchFullOutput() : output;
    return terminalCommandCopyText(record, retainedOutput ?? output);
  };

  return (
    <div className="mx-1 overflow-hidden rounded-lg border border-border/60 bg-card/35 shadow-sm">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
            aria-hidden="true"
          />
          <TerminalIcon className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col text-message-foreground">
            {visibleCommandLines.map((line) => (
              <span className="truncate" key={line.key}>
                {line.text}
              </span>
            ))}
            {hiddenCommandLineCount > 0 ? (
              <span className="text-xs text-muted-foreground">+{hiddenCommandLineCount} more</span>
            ) : null}
          </span>
          {collapsed ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {terminalCommandStatusText(record)}
            </span>
          ) : null}
        </button>
        {active ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() =>
              void cancel({
                environmentId,
                input: { threadId, executionId: record.executionId },
              })
            }
          >
            <SquareIcon className="size-3" />
            Cancel
          </Button>
        ) : null}
      </div>
      {collapsed ? null : (
        <>
          <div className="border-t border-border/60">
            {output.length > 0 ? (
              <ReadonlyTerminalSurface
                output={output}
                fontFamily={terminalFontFamily}
                fontSize={terminalFontSize}
              />
            ) : (
              <div className="px-2.5 py-2 font-mono text-xs text-muted-foreground">
                {record.status === "queued" ? "Waiting to run…" : "Running…"}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
            <span>{terminalCommandStatusText(record)}</span>
            <span className="flex items-center gap-1">
              {record.truncated ? (
                <button
                  type="button"
                  className="text-emerald-600 hover:text-emerald-500 disabled:opacity-50 dark:text-emerald-400 dark:hover:text-emerald-300"
                  disabled={loadingFullOutput}
                  onClick={() => void loadFullOutput()}
                >
                  {loadingFullOutput
                    ? "Loading…"
                    : fullOutput === null
                      ? "View retained output"
                      : "Show excerpt"}
                </button>
              ) : null}
              {!active ? (
                <MessageCopyButton
                  text={copyTerminalBlock}
                  onPrepare={() => {
                    if (record.truncated) void fetchFullOutput();
                  }}
                  size="icon-xs"
                  variant="ghost"
                  className="size-5"
                />
              ) : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

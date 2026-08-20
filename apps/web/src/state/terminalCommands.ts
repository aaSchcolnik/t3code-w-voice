import {
  EMPTY_TERMINAL_COMMAND_STREAM_STATE,
  type TerminalCommandStreamState,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, TerminalExecAttachInput } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

export function useAttachedTerminalCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly execution: TerminalExecAttachInput | null;
}): TerminalCommandStreamState & { readonly error: unknown | null } {
  const attach = useEnvironmentQuery(
    input.execution === null
      ? null
      : terminalEnvironment.execAttach({
          environmentId: input.environmentId,
          input: input.execution,
        }),
  );
  useEffect(() => {
    if (attach.data?.needsResync) attach.refresh();
  }, [attach.data?.needsResync, attach.refresh]);
  return useMemo(
    () => ({
      ...(attach.data ?? EMPTY_TERMINAL_COMMAND_STREAM_STATE),
      error: attach.error,
    }),
    [attach.data, attach.error],
  );
}

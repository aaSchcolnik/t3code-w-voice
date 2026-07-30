import { useAtomValue } from "@effect/atom-react";
import { createSubagentEnvironmentAtoms } from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, SubagentRun, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const subagentEnvironment = createSubagentEnvironmentAtoms(connectionAtomRuntime);

export function useSubagentRuns(environmentId: EnvironmentId, rootThreadId: ThreadId) {
  const atom = useMemo(
    () => subagentEnvironment.runs({ environmentId, input: { rootThreadId } }),
    [environmentId, rootThreadId],
  );
  const result = useAtomValue(atom);
  return {
    authoritative: AsyncResult.isSuccess(result),
    error: AsyncResult.isFailure(result),
    runs: Option.getOrNull(AsyncResult.value(result))?.runs ?? ([] as ReadonlyArray<SubagentRun>),
  };
}

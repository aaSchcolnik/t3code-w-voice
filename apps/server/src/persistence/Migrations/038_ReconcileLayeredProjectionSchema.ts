import * as Effect from "effect/Effect";
import ProjectMcpOverrides from "./033_ProjectMcpOverrides.ts";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";

export default Effect.gen(function* () {
  // The main/voice and subagents branches independently assigned migration 33.
  // Reconcile both schemas after the histories converge without renumbering an
  // already-released migration and invalidating existing migration records.
  yield* ProjectMcpOverrides;
  yield* ProjectionThreadsSettled;
});

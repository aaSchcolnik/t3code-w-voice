import * as Effect from "effect/Effect";
import ProjectMcpOverrides from "./033_ProjectMcpOverrides.ts";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";
import ProjectionThreadsSnoozed from "./034_ProjectionThreadsSnoozed.ts";
import Skills from "./034_Skills.ts";

export default Effect.gen(function* () {
  // The main/voice and subagents branches independently assigned migrations
  // 33 and 34.
  // Reconcile both schemas after the histories converge without renumbering an
  // already-released migration and invalidating existing migration records.
  yield* ProjectMcpOverrides;
  yield* ProjectionThreadsSettled;
  yield* Skills;
  yield* ProjectionThreadsSnoozed;
});

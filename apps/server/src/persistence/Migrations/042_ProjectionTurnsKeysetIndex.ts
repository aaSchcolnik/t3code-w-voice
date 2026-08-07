import ProjectionTurnsKeysetIndex from "./037_ProjectionTurnsKeysetIndex.ts";

// Upstream assigned migration 37 after the fork had already shipped its own
// migration 37. Replay the idempotent index migration under the next free ID.
export default ProjectionTurnsKeysetIndex;

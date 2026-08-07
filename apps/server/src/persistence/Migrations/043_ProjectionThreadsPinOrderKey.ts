import ProjectionThreadsPinOrderKey from "./038_ProjectionThreadsPinOrderKey.ts";

// Upstream assigned migration 38 after the fork had already shipped its own
// migrations 38 and 39. Replay the idempotent column migration under the next
// free ID so existing fork databases receive the pin ordering schema.
export default ProjectionThreadsPinOrderKey;

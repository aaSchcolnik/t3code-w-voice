import { createFileRoute } from "@tanstack/react-router";

import { LimitsSettingsPanel } from "../components/settings/LimitsSettings";

export const Route = createFileRoute("/settings/limits")({
  component: LimitsSettingsPanel,
});

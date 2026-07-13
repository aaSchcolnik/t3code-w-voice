import { createFileRoute } from "@tanstack/react-router";

import { KnowledgeSettingsPanel } from "../components/settings/KnowledgeSettings";

export const Route = createFileRoute("/settings/knowledge")({
  component: KnowledgeSettingsPanel,
});

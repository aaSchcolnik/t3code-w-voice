import { useAtomValue } from "@effect/atom-react";
import { BotIcon, Code2Icon, MonitorSmartphoneIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function McpSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntries = deriveProviderInstanceEntries(providers);
  const codexAvailable = providerEntries.some(
    (entry) =>
      entry.driverKind === "codex" && entry.enabled && entry.installed && entry.isAvailable,
  );
  const cursorAvailable = providerEntries.some(
    (entry) =>
      entry.driverKind === "cursor" && entry.enabled && entry.installed && entry.isAvailable,
  );

  const updateMcp = (patch: Partial<typeof settings.mcp>) =>
    updateSettings({ mcp: { ...settings.mcp, ...patch } });

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">MCP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control the built-in toolkits granted to new agent sessions. Changes apply when a new
          session starts.
        </p>
      </div>
      <SettingsSection title="T3 Code MCP">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <MonitorSmartphoneIcon className="size-4 text-muted-foreground" />
              Browser Preview
            </span>
          }
          description="Lets agents open, inspect, and drive the in-app browser preview."
          control={
            <Switch
              checked={settings.mcp.preview}
              onCheckedChange={(checked) => updateMcp({ preview: Boolean(checked) })}
              aria-label="Enable Browser Preview MCP toolkit"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <Code2Icon className="size-4 text-muted-foreground" />
              Codex Agent
            </span>
          }
          description="Lets the current agent delegate one-shot tasks to Codex as tracked subagents."
          status={
            codexAvailable
              ? "Available for new sessions"
              : "Not available: configure and enable a Codex provider under Providers."
          }
          control={
            <Switch
              checked={settings.mcp.codexAgent}
              disabled={!codexAvailable}
              onCheckedChange={(checked) => updateMcp({ codexAgent: Boolean(checked) })}
              aria-label="Enable Codex Agent MCP toolkit"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <BotIcon className="size-4 text-muted-foreground" />
              Cursor Agent
            </span>
          }
          description="Lets the current agent delegate one-shot tasks to Cursor as tracked subagents."
          status={
            cursorAvailable
              ? "Available for new sessions"
              : "Not available: configure and enable a Cursor provider under Providers."
          }
          control={
            <Switch
              checked={settings.mcp.cursorAgent}
              disabled={!cursorAvailable}
              onCheckedChange={(checked) => updateMcp({ cursorAgent: Boolean(checked) })}
              aria-label="Enable Cursor Agent MCP toolkit"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

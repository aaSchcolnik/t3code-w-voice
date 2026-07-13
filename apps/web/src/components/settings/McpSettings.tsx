import { useAtomValue } from "@effect/atom-react";
import { type ProjectMcpOverrides } from "@t3tools/contracts";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI, CursorIcon, OpenAI } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type McpBooleanKey = "preview" | "codexAgent" | "cursorAgent" | "claudeAgent";

export function McpBooleanControl({
  projectScoped,
  globalValue,
  projectValue,
  label,
  disabled,
  onGlobalChange,
  onProjectChange,
}: {
  projectScoped: boolean;
  globalValue: boolean;
  projectValue: boolean | undefined;
  label: string;
  disabled?: boolean;
  onGlobalChange: (value: boolean) => void;
  onProjectChange: (value: boolean | undefined) => void;
}) {
  if (!projectScoped) {
    return (
      <Switch
        checked={globalValue}
        disabled={disabled}
        onCheckedChange={(checked) => onGlobalChange(Boolean(checked))}
        aria-label={label}
      />
    );
  }
  return (
    <div className="flex items-center gap-2">
      {projectValue === undefined ? <Badge variant="secondary">Inherited</Badge> : null}
      <Select
        items={[
          { value: "inherit", label: `Inherit (${globalValue ? "On" : "Off"})` },
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
        value={projectValue === undefined ? "inherit" : projectValue ? "on" : "off"}
        disabled={disabled}
        onValueChange={(value) => onProjectChange(value === "inherit" ? undefined : value === "on")}
      >
        <SelectTrigger className="w-36" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectItem value="inherit">Inherit ({globalValue ? "On" : "Off"})</SelectItem>
            <SelectItem value="on">On</SelectItem>
            <SelectItem value="off">Off</SelectItem>
          </SelectGroup>
        </SelectPopup>
      </Select>
    </div>
  );
}

export function McpSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntries = deriveProviderInstanceEntries(providers);
  const projects = useProjects();
  const [scope, setScope] = useState("global");
  const updateProjectMcp = useAtomCommand(projectEnvironment.updateMcpSettings);
  const selectedProject = projects.find(
    (project) => `${project.environmentId}:${project.id}` === scope,
  );
  const projectOverrides = selectedProject?.mcpOverrides ?? undefined;
  const codexAvailable = providerEntries.some(
    (entry) =>
      entry.driverKind === "codex" && entry.enabled && entry.installed && entry.isAvailable,
  );
  const cursorAvailable = providerEntries.some(
    (entry) =>
      entry.driverKind === "cursor" && entry.enabled && entry.installed && entry.isAvailable,
  );
  const claudeAvailable = providerEntries.some(
    (entry) =>
      entry.driverKind === "claudeAgent" && entry.enabled && entry.installed && entry.isAvailable,
  );

  const updateMcp = (patch: Partial<typeof settings.mcp>) =>
    updateSettings({ mcp: { ...settings.mcp, ...patch } });
  const persistProjectOverrides = (next: ProjectMcpOverrides) => {
    if (selectedProject === undefined) return;
    void updateProjectMcp({
      environmentId: selectedProject.environmentId,
      input: { projectId: selectedProject.id, mcpOverrides: next },
    });
  };
  const updateProjectBoolean = (key: McpBooleanKey, value: boolean | undefined) => {
    const next: Record<string, unknown> = { ...projectOverrides };
    if (value === undefined) delete next[key];
    else next[key] = value;
    persistProjectOverrides(next as ProjectMcpOverrides);
  };

  const scopeItems = [
    { value: "global", label: "Global defaults" },
    ...projects.map((project) => ({
      value: `${project.environmentId}:${project.id}`,
      label: project.title,
    })),
  ];

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">MCP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control the built-in toolkits granted to new agent sessions. Changes apply when a new
          session starts.
        </p>
      </div>
      <Field>
        <FieldLabel>Settings scope</FieldLabel>
        <FieldDescription>
          Project settings inherit global defaults until you explicitly override them.
        </FieldDescription>
        <div className="flex items-center gap-2">
          <Select
            items={scopeItems}
            value={scope}
            onValueChange={(value) => value && setScope(value)}
          >
            <SelectTrigger className="max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                {scopeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          {selectedProject !== undefined ? (
            <Button
              variant="outline"
              onClick={() =>
                persistProjectOverrides(
                  projectOverrides?.skills === undefined ? {} : { skills: projectOverrides.skills },
                )
              }
            >
              Reset all to global
            </Button>
          ) : null}
        </div>
      </Field>
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
            <McpBooleanControl
              projectScoped={selectedProject !== undefined}
              globalValue={settings.mcp.preview}
              projectValue={projectOverrides?.preview}
              label="Enable Browser Preview MCP toolkit"
              onGlobalChange={(preview) => updateMcp({ preview })}
              onProjectChange={(preview) => updateProjectBoolean("preview", preview)}
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <ClaudeAI className="size-4 shrink-0" aria-hidden />
              Claude Agent
            </span>
          }
          description="Lets the current agent delegate one-shot tasks to Claude as tracked subagents."
          status={
            claudeAvailable
              ? "Available for new sessions"
              : "Not available: configure and enable a Claude provider under Providers."
          }
          control={
            <McpBooleanControl
              projectScoped={selectedProject !== undefined}
              globalValue={settings.mcp.claudeAgent}
              projectValue={projectOverrides?.claudeAgent}
              disabled={!claudeAvailable}
              label="Enable Claude Agent MCP toolkit"
              onGlobalChange={(claudeAgent) => updateMcp({ claudeAgent })}
              onProjectChange={(claudeAgent) => updateProjectBoolean("claudeAgent", claudeAgent)}
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <OpenAI className="size-4 shrink-0" aria-hidden />
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
            <McpBooleanControl
              projectScoped={selectedProject !== undefined}
              globalValue={settings.mcp.codexAgent}
              projectValue={projectOverrides?.codexAgent}
              disabled={!codexAvailable}
              label="Enable Codex Agent MCP toolkit"
              onGlobalChange={(codexAgent) => updateMcp({ codexAgent })}
              onProjectChange={(codexAgent) => updateProjectBoolean("codexAgent", codexAgent)}
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <CursorIcon className="size-4 shrink-0" aria-hidden />
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
            <McpBooleanControl
              projectScoped={selectedProject !== undefined}
              globalValue={settings.mcp.cursorAgent}
              projectValue={projectOverrides?.cursorAgent}
              disabled={!cursorAvailable}
              label="Enable Cursor Agent MCP toolkit"
              onGlobalChange={(cursorAgent) => updateMcp({ cursorAgent })}
              onProjectChange={(cursorAgent) => updateProjectBoolean("cursorAgent", cursorAgent)}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

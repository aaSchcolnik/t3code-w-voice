import { useAtomValue } from "@effect/atom-react";
import {
  DELEGATED_PROVIDERS,
  type DelegatedProviderSettingKey,
  type DelegatedRunProvider,
  type EngineDelegationRole,
  type EngineDelegationSettings,
  type EngineDelegationTarget,
  type ProjectMcpOverrides,
  type ServerSettingsPatch,
  SCOUT_DEFAULTS,
  WORKER_DEFAULTS,
} from "@t3tools/contracts";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { AntigravityIcon, ClaudeAI, CursorIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";
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
import { ChainEditor } from "./EngineDelegationSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ComputerUseSettingsSection } from "./ComputerUseSettings";

type McpBooleanKey = "preview" | DelegatedProviderSettingKey;

const DELEGATED_PROVIDER_ICONS: Record<DelegatedRunProvider, Icon> = {
  codex: OpenAI,
  cursor: CursorIcon,
  claudeAgent: ClaudeAI,
  antigravity: AntigravityIcon,
  opencode: OpenCodeIcon,
};
type DelegationRoleChain = Extract<EngineDelegationRole, "scout" | "worker">;
type GlobalDelegationRolesPatch = Partial<
  Record<EngineDelegationRole, ReadonlyArray<EngineDelegationTarget>>
>;

/** Picks "a" or "an" for provider labels such as OpenCode and Antigravity. */
function indefiniteArticle(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export function withProjectDelegationRole(
  overrides: ProjectMcpOverrides | undefined,
  role: DelegationRoleChain,
  chain: ReadonlyArray<EngineDelegationTarget> | undefined,
): ProjectMcpOverrides {
  const next = { ...overrides } as Record<string, unknown>;
  const engine = { ...overrides?.engine } as Record<string, unknown>;
  const delegation = { ...overrides?.engine?.delegation } as Record<string, unknown>;
  const roles = { ...overrides?.engine?.delegation?.roles } as Record<string, unknown>;
  if (chain === undefined) delete roles[role];
  else roles[role] = chain;
  if (Object.keys(roles).length === 0) delete delegation.roles;
  else delegation.roles = roles;
  if (Object.keys(delegation).length === 0) delete engine.delegation;
  else engine.delegation = delegation;
  if (Object.keys(engine).length === 0) delete next.engine;
  else next.engine = engine;
  return next as ProjectMcpOverrides;
}

export function withGlobalDelegationRole(
  roles: EngineDelegationSettings["roles"],
  role: DelegationRoleChain,
  chain: ReadonlyArray<EngineDelegationTarget> | undefined,
): GlobalDelegationRolesPatch {
  const next: GlobalDelegationRolesPatch = {};
  if (roles.scout !== undefined) next.scout = roles.scout;
  if (roles.worker !== undefined) next.worker = roles.worker;
  if (roles.consensus !== undefined) next.consensus = roles.consensus;
  if (roles.scanner !== undefined) next.scanner = roles.scanner;
  if (chain === undefined) delete next[role];
  else next[role] = chain;
  return next;
}

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
  const isDelegatedProviderAvailable = (provider: DelegatedRunProvider) =>
    providerEntries.some(
      (entry) =>
        entry.driverKind === provider &&
        entry.enabled &&
        entry.installed &&
        entry.isAvailable &&
        entry.snapshot.delegation?.available !== false,
    );
  const delegatedProviderRows = Object.entries(DELEGATED_PROVIDERS).sort(([, left], [, right]) =>
    left.label.localeCompare(right.label),
  );

  const updateMcp = (patch: NonNullable<ServerSettingsPatch["mcp"]>) =>
    updateSettings({ mcp: patch });
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
  const globalRoleChain = (role: DelegationRoleChain) =>
    settings.mcp.engine.delegation.roles[role] ??
    (role === "scout" ? SCOUT_DEFAULTS : WORKER_DEFAULTS);
  const effectiveRoleChain = (role: DelegationRoleChain) =>
    projectOverrides?.engine?.delegation?.roles?.[role] ?? globalRoleChain(role);
  const updateRoleChain = (
    role: DelegationRoleChain,
    chain: ReadonlyArray<EngineDelegationTarget>,
  ) => {
    if (selectedProject === undefined) {
      updateMcp({
        engine: {
          delegation: {
            roles: withGlobalDelegationRole(settings.mcp.engine.delegation.roles, role, chain),
          },
        },
      });
      return;
    }
    persistProjectOverrides(withProjectDelegationRole(projectOverrides, role, chain));
  };
  const resetRoleChain = (role: DelegationRoleChain) => {
    if (selectedProject === undefined) {
      updateMcp({
        engine: {
          delegation: {
            roles: withGlobalDelegationRole(settings.mcp.engine.delegation.roles, role, undefined),
          },
        },
      });
      return;
    }
    persistProjectOverrides(withProjectDelegationRole(projectOverrides, role, undefined));
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
          Control the built-in toolkits granted to agent sessions. Changes apply when a new session
          starts; delegation role preferences select provider-specific tools for engine workflows.
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
      <SettingsSection title="Delegation roles">
        {(["scout", "worker"] as const).map((role) => {
          const overridden = projectOverrides?.engine?.delegation?.roles?.[role] !== undefined;
          return (
            <SettingsRow
              key={role}
              title={`${role === "scout" ? "Scout" : "Worker"} chain`}
              description={
                role === "scout"
                  ? "Provider preference for read-only research, planning, and evidence gathering."
                  : "Provider preference for implementation, debugging, and testing that may write to the workspace."
              }
              status={
                selectedProject !== undefined
                  ? overridden
                    ? "Overridden for this project"
                    : "Inherited from the global chain"
                  : "The engine selects the first available provider-specific target."
              }
              resetAction={
                (
                  selectedProject === undefined
                    ? settings.mcp.engine.delegation.roles[role] !== undefined
                    : overridden
                ) ? (
                  <SettingResetButton
                    label={
                      selectedProject === undefined
                        ? `${role} chain to automatic defaults`
                        : `${role} chain to global`
                    }
                    onClick={() => resetRoleChain(role)}
                  />
                ) : null
              }
            >
              <div className="space-y-2 pt-3">
                <p className="text-xs text-muted-foreground">
                  Changing a target configures future delegated {role} lanes. It does not start a
                  run or change the model used by the current parent thread.
                </p>
                <ChainEditor
                  role={role}
                  chain={effectiveRoleChain(role)}
                  providerEntries={providerEntries}
                  showAvailability={false}
                  onChange={(chain) => updateRoleChain(role, chain)}
                />
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>
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
        {delegatedProviderRows.map(([provider, spec]) => {
          const delegatedProvider = provider as DelegatedRunProvider;
          const ProviderIcon = DELEGATED_PROVIDER_ICONS[delegatedProvider];
          const available = isDelegatedProviderAvailable(delegatedProvider);
          const { settingKey, label } = spec;
          return (
            <SettingsRow
              key={provider}
              title={
                <span className="inline-flex items-center gap-2">
                  <ProviderIcon className="size-4 shrink-0" aria-hidden />
                  {label} Agent
                </span>
              }
              description={`Lets the current agent delegate one-shot tasks to ${label} as tracked subagents.`}
              status={
                available
                  ? "Available for new sessions"
                  : `Not available: configure and enable ${indefiniteArticle(label)} ${label} provider under Providers.`
              }
              control={
                <McpBooleanControl
                  projectScoped={selectedProject !== undefined}
                  globalValue={settings.mcp[settingKey]}
                  projectValue={projectOverrides?.[settingKey]}
                  disabled={!available}
                  label={`Enable ${label} Agent MCP toolkit`}
                  onGlobalChange={(value) => updateMcp({ [settingKey]: value })}
                  onProjectChange={(value) => updateProjectBoolean(settingKey, value)}
                />
              }
            />
          );
        })}
      </SettingsSection>
      <ComputerUseSettingsSection
        {...(selectedProject
          ? { environmentId: selectedProject.environmentId, cwd: selectedProject.workspaceRoot }
          : {})}
      />
    </SettingsPageContainer>
  );
}

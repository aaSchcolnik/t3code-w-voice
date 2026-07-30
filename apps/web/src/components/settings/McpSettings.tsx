import { useAtomValue } from "@effect/atom-react";
import {
  type DelegationMode,
  type DelegationRouterSettings,
  type EngineDelegationRole,
  type EngineDelegationTarget,
  type ProjectMcpOverrides,
  type ServerSettingsPatch,
  SCOUT_DEFAULTS,
  WORKER_DEFAULTS,
  resolveEffectiveMcpSettings,
} from "@t3tools/contracts";
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
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ChainEditor } from "./EngineDelegationSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ComputerUseSettingsSection } from "./ComputerUseSettings";

type McpBooleanKey = "preview" | "codexAgent" | "cursorAgent" | "claudeAgent";
type RouterSettingKey = keyof DelegationRouterSettings;
type RouterRole = Extract<EngineDelegationRole, "scout" | "worker">;

export const routerModeLabels: Record<DelegationMode, string> = {
  off: "Off",
  suggested: "Suggested",
  proactive: "Proactive",
};

export function withProjectRouterSetting(
  overrides: ProjectMcpOverrides | undefined,
  key: RouterSettingKey,
  value: DelegationRouterSettings[RouterSettingKey] | undefined,
): ProjectMcpOverrides {
  const next = { ...overrides } as Record<string, unknown>;
  const router = { ...overrides?.router } as Record<string, unknown>;
  if (value === undefined) delete router[key];
  else router[key] = value;
  if (Object.keys(router).length === 0) delete next.router;
  else next.router = router;
  return next as ProjectMcpOverrides;
}

export function withoutProjectRouterSettings(
  overrides: ProjectMcpOverrides | undefined,
): ProjectMcpOverrides {
  const next = { ...overrides } as Record<string, unknown>;
  delete next.router;
  return next as ProjectMcpOverrides;
}

export function withProjectRouterRole(
  overrides: ProjectMcpOverrides | undefined,
  role: RouterRole,
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

function RouterModeControl({
  value,
  inherited,
  onChange,
}: {
  value: DelegationMode;
  inherited: boolean;
  onChange: (value: DelegationMode) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {inherited ? <Badge variant="secondary">Inherited</Badge> : null}
      <ToggleGroup
        aria-label="Delegation router mode"
        variant="outline"
        size="sm"
        value={[value]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "off" || next === "suggested" || next === "proactive") onChange(next);
        }}
      >
        {(Object.entries(routerModeLabels) as ReadonlyArray<[DelegationMode, string]>).map(
          ([mode, label]) => (
            <Toggle key={mode} value={mode} aria-label={`${label} delegation mode`}>
              {label}
            </Toggle>
          ),
        )}
      </ToggleGroup>
    </div>
  );
}

function RouterNumberControl({
  value,
  inherited,
  label,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  inherited: boolean;
  label: string;
  min: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {inherited ? <Badge variant="secondary">Inherited</Badge> : null}
      <NumberField
        value={value}
        min={min}
        max={max}
        step={step}
        size="sm"
        className="w-32"
        onValueChange={(next) => {
          if (typeof next === "number" && Number.isFinite(next)) {
            onChange(Math.max(min, Math.round(next)));
          }
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label}`} />
          <NumberFieldInput aria-label={label} />
          <NumberFieldIncrement aria-label={`Increase ${label}`} />
        </NumberFieldGroup>
      </NumberField>
      {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function RouterSelectControl<T extends string>({
  value,
  inherited,
  label,
  items,
  onChange,
}: {
  value: T;
  inherited: boolean;
  label: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {inherited ? <Badge variant="secondary">Inherited</Badge> : null}
      <Select
        items={[...items]}
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next as T);
        }}
      >
        <SelectTrigger className="w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
    </div>
  );
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
  const effectiveMcp = resolveEffectiveMcpSettings(settings.mcp, projectOverrides);
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
  const updateRouterSetting = <K extends RouterSettingKey>(
    key: K,
    value: DelegationRouterSettings[K],
  ) => {
    if (selectedProject === undefined) {
      updateMcp({ router: { [key]: value } });
      return;
    }
    persistProjectOverrides(withProjectRouterSetting(projectOverrides, key, value));
  };
  const resetRouterSetting = (key: RouterSettingKey) => {
    persistProjectOverrides(withProjectRouterSetting(projectOverrides, key, undefined));
  };
  const globalRoleChain = (role: RouterRole) =>
    settings.mcp.engine.delegation.roles[role] ??
    (role === "scout" ? SCOUT_DEFAULTS : WORKER_DEFAULTS);
  const effectiveRoleChain = (role: RouterRole) =>
    projectOverrides?.engine?.delegation?.roles?.[role] ?? globalRoleChain(role);
  const updateRoleChain = (role: RouterRole, chain: ReadonlyArray<EngineDelegationTarget>) => {
    if (selectedProject === undefined) {
      updateMcp({ engine: { delegation: { roles: { [role]: chain } } } });
      return;
    }
    persistProjectOverrides(withProjectRouterRole(projectOverrides, role, chain));
  };
  const resetRoleChain = (role: RouterRole) => {
    persistProjectOverrides(withProjectRouterRole(projectOverrides, role, undefined));
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
      <SettingsSection
        title="Delegation router"
        headerAction={
          selectedProject !== undefined &&
          (projectOverrides?.router !== undefined ||
            projectOverrides?.engine?.delegation?.roles?.scout !== undefined ||
            projectOverrides?.engine?.delegation?.roles?.worker !== undefined) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const withoutRouter = withoutProjectRouterSettings(projectOverrides);
                const withoutScout = withProjectRouterRole(withoutRouter, "scout", undefined);
                persistProjectOverrides(withProjectRouterRole(withoutScout, "worker", undefined));
              }}
            >
              Reset router to global
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Router mode"
          description="Controls whether parent agents can use provider-neutral delegation. Turning it off leaves existing runs available to inspect, cancel, or answer."
          status={
            selectedProject !== undefined
              ? projectOverrides?.router?.mode === undefined
                ? `Inherited from global: ${routerModeLabels[settings.mcp.router.mode]}`
                : "Overridden for this project"
              : "Applies to projects without an override"
          }
          resetAction={
            selectedProject !== undefined && projectOverrides?.router?.mode !== undefined ? (
              <SettingResetButton
                label="delegation router mode to global"
                onClick={() => resetRouterSetting("mode")}
              />
            ) : null
          }
          control={
            <RouterModeControl
              value={effectiveMcp.router.mode}
              inherited={
                selectedProject !== undefined && projectOverrides?.router?.mode === undefined
              }
              onChange={(mode) => updateRouterSetting("mode", mode)}
            />
          }
        />
        {(
          [
            {
              key: "maxBatchSize",
              title: "Maximum batch size",
              description: "Most lanes accepted in one atomic routing request.",
              min: 1,
              max: 4,
              suffix: "lanes",
            },
            {
              key: "maxConcurrentPerParent",
              title: "Parent concurrency",
              description: "Active delegated runs allowed for one parent thread.",
              min: 1,
              max: 64,
              suffix: "runs",
            },
            {
              key: "maxConcurrentEnvironment",
              title: "Environment concurrency",
              description: "Active delegated runs allowed across this environment.",
              min: 1,
              max: 128,
              suffix: "runs",
            },
          ] as const
        ).map(({ key, title, description, min, max, suffix }) => {
          const overridden = projectOverrides?.router?.[key] !== undefined;
          return (
            <SettingsRow
              key={key}
              title={title}
              description={description}
              status={
                selectedProject !== undefined
                  ? overridden
                    ? "Overridden for this project"
                    : `Inherited from global: ${settings.mcp.router[key]}`
                  : undefined
              }
              resetAction={
                selectedProject !== undefined && overridden ? (
                  <SettingResetButton
                    label={`${title.toLowerCase()} to global`}
                    onClick={() => resetRouterSetting(key)}
                  />
                ) : null
              }
              control={
                <RouterNumberControl
                  value={effectiveMcp.router[key]}
                  inherited={selectedProject !== undefined && !overridden}
                  label={title}
                  min={min}
                  max={max}
                  suffix={suffix}
                  onChange={(value) => updateRouterSetting(key, value)}
                />
              }
            />
          );
        })}
        <SettingsRow
          title="Delegated run timeout"
          description="Deadline measured from durable allocation. Expiry requests cancellation and never activates fallback."
          status={
            selectedProject !== undefined
              ? projectOverrides?.router?.defaultTimeoutMs === undefined
                ? `Inherited from global: ${Math.round(settings.mcp.router.defaultTimeoutMs / 60_000)} minutes`
                : "Overridden for this project"
              : undefined
          }
          resetAction={
            selectedProject !== undefined &&
            projectOverrides?.router?.defaultTimeoutMs !== undefined ? (
              <SettingResetButton
                label="delegated run timeout to global"
                onClick={() => resetRouterSetting("defaultTimeoutMs")}
              />
            ) : null
          }
          control={
            <RouterNumberControl
              value={Math.round(effectiveMcp.router.defaultTimeoutMs / 60_000)}
              inherited={
                selectedProject !== undefined &&
                projectOverrides?.router?.defaultTimeoutMs === undefined
              }
              label="Delegated run timeout in minutes"
              min={1}
              max={1_440}
              suffix="minutes"
              onChange={(minutes) => updateRouterSetting("defaultTimeoutMs", minutes * 60_000)}
            />
          }
        />
        <SettingsRow
          title="Batch diversity"
          description="Prefer unused providers within the configured eligible chain. Hard constraints and chain order still win."
          status={
            selectedProject !== undefined
              ? projectOverrides?.router?.diversity === undefined
                ? `Inherited from global: ${settings.mcp.router.diversity}`
                : "Overridden for this project"
              : undefined
          }
          resetAction={
            selectedProject !== undefined && projectOverrides?.router?.diversity !== undefined ? (
              <SettingResetButton
                label="batch diversity to global"
                onClick={() => resetRouterSetting("diversity")}
              />
            ) : null
          }
          control={
            <RouterSelectControl
              value={effectiveMcp.router.diversity}
              inherited={
                selectedProject !== undefined && projectOverrides?.router?.diversity === undefined
              }
              label="Batch diversity preference"
              items={[
                { value: "off", label: "Keep chain order" },
                { value: "prefer", label: "Prefer diversity" },
              ]}
              onChange={(diversity) => updateRouterSetting("diversity", diversity)}
            />
          }
        />
        <SettingsRow
          title="Fallback policy"
          description="Fallback is allowed only before provider dispatch begins. Ambiguous post-dispatch failures are never replayed."
          status={
            selectedProject !== undefined
              ? projectOverrides?.router?.fallback === undefined
                ? `Inherited from global: ${settings.mcp.router.fallback}`
                : "Overridden for this project"
              : undefined
          }
          resetAction={
            selectedProject !== undefined && projectOverrides?.router?.fallback !== undefined ? (
              <SettingResetButton
                label="fallback policy to global"
                onClick={() => resetRouterSetting("fallback")}
              />
            ) : null
          }
          control={
            <RouterSelectControl
              value={effectiveMcp.router.fallback}
              inherited={
                selectedProject !== undefined && projectOverrides?.router?.fallback === undefined
              }
              label="Delegation fallback policy"
              items={[
                { value: "none", label: "No fallback" },
                { value: "pre-dispatch", label: "Before dispatch" },
              ]}
              onChange={(fallback) => updateRouterSetting("fallback", fallback)}
            />
          }
        />
        <SettingsRow
          title="Explanation detail"
          description="Controls how much server-authored routing rationale is retained for run diagnostics."
          status={
            selectedProject !== undefined
              ? projectOverrides?.router?.explanation === undefined
                ? `Inherited from global: ${settings.mcp.router.explanation}`
                : "Overridden for this project"
              : undefined
          }
          resetAction={
            selectedProject !== undefined && projectOverrides?.router?.explanation !== undefined ? (
              <SettingResetButton
                label="explanation detail to global"
                onClick={() => resetRouterSetting("explanation")}
              />
            ) : null
          }
          control={
            <RouterSelectControl
              value={effectiveMcp.router.explanation}
              inherited={
                selectedProject !== undefined && projectOverrides?.router?.explanation === undefined
              }
              label="Route explanation detail"
              items={[
                { value: "summary", label: "Summary" },
                { value: "full", label: "Full diagnostics" },
              ]}
              onChange={(explanation) => updateRouterSetting("explanation", explanation)}
            />
          }
        />
        {(["scout", "worker"] as const).map((role) => {
          const overridden = projectOverrides?.engine?.delegation?.roles?.[role] !== undefined;
          return (
            <SettingsRow
              key={role}
              title={`${role === "scout" ? "Scout" : "Worker"} chain`}
              description={
                role === "scout"
                  ? "Ordered server routing targets for research, planning, and evidence gathering."
                  : "Ordered server routing targets for implementation, debugging, and testing."
              }
              status={
                selectedProject !== undefined
                  ? overridden
                    ? "Overridden for this project"
                    : "Inherited from the global chain"
                  : "The server validates candidate capabilities and exclusions at route time."
              }
              resetAction={
                selectedProject !== undefined && overridden ? (
                  <SettingResetButton
                    label={`${role} chain to global`}
                    onClick={() => resetRoleChain(role)}
                  />
                ) : null
              }
            >
              <div className="pt-3">
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
      <ComputerUseSettingsSection
        {...(selectedProject
          ? { environmentId: selectedProject.environmentId, cwd: selectedProject.workspaceRoot }
          : {})}
      />
    </SettingsPageContainer>
  );
}

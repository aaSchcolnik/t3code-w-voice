import type {
  DelegationMode,
  EnvironmentId,
  ProjectId,
  ProjectMcpOverrides,
} from "@t3tools/contracts";

export type RouterSettingsScope =
  | {
      readonly type: "environment";
      readonly environmentId: EnvironmentId;
      readonly label: string;
    }
  | {
      readonly type: "project";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly label: string;
      readonly overrides: ProjectMcpOverrides | null | undefined;
    };

export const ROUTER_MODE_OPTIONS: ReadonlyArray<{
  readonly value: DelegationMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "off",
    label: "Off",
    description: "Do not route new delegated work.",
  },
  {
    value: "suggested",
    label: "Suggested",
    description: "Route only when the parent explicitly requests delegation.",
  },
  {
    value: "proactive",
    label: "Proactive",
    description: "Allow eligible workflows to route work automatically.",
  },
];

export function routerSettingsScopeKey(scope: RouterSettingsScope): string {
  return scope.type === "environment"
    ? `environment:${scope.environmentId}`
    : `project:${scope.environmentId}:${scope.projectId}`;
}

export function projectRouterMode(
  globalMode: DelegationMode,
  overrides: ProjectMcpOverrides | null | undefined,
): { readonly effective: DelegationMode; readonly inherited: boolean } {
  return {
    effective: overrides?.router?.mode ?? globalMode,
    inherited: overrides?.router?.mode === undefined,
  };
}

import type { EnvironmentId } from "@t3tools/contracts";

export interface UsageEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function sortUsageEnvironments(
  environments: ReadonlyArray<UsageEnvironmentOption>,
): UsageEnvironmentOption[] {
  return [...environments].sort((left, right) =>
    left.label.toLocaleLowerCase().localeCompare(right.label.toLocaleLowerCase()),
  );
}

export function resolveUsageEnvironmentId(
  environments: ReadonlyArray<UsageEnvironmentOption>,
  selectedEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type UsageScreenErrorKind = "unsupported-server" | "request-failed";

export function classifyUsageScreenError(error: string | null): UsageScreenErrorKind | null {
  if (error === null) return null;
  return /(?:^|:\s)Unknown request tag: usage\.read(?:$|\s)/.test(error)
    ? "unsupported-server"
    : "request-failed";
}

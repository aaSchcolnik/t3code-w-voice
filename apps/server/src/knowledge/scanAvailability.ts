import {
  DELEGATED_PROVIDERS,
  isProviderAvailable,
  type DelegatedRunProvider,
  type McpSettings,
  type ModelSelection,
  resolveDelegationRoles,
  type ServerProvider,
} from "@t3tools/contracts";

const providerUsable = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "disabled" &&
  provider.status !== "error";

const preferredProvider = (
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined => {
  const exact = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (exact !== undefined) return exact;
  const legacyDriver = String(selection.instanceId);
  return providers.find((provider) => provider.driver === legacyDriver);
};

export function resolveKnowledgeScanConfiguration(input: {
  readonly mcp: McpSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectDefaultModel?: ModelSelection | undefined;
}) {
  const usableProviders = input.providers.filter(providerUsable);
  const available = new Set<DelegatedRunProvider>();
  for (const driver of Object.keys(DELEGATED_PROVIDERS) as ReadonlyArray<DelegatedRunProvider>) {
    if (usableProviders.some((provider) => provider.driver === driver)) {
      available.add(driver);
    }
  }
  const panel = resolveDelegationRoles(input.mcp.engine.delegation, available).scanner;
  const availableScanners = panel.filter((target) =>
    usableProviders.some(
      (provider) =>
        provider.driver === target.provider &&
        (target.providerInstanceId === undefined ||
          provider.instanceId === target.providerInstanceId) &&
        (target.model === undefined ||
          provider.models.some((model) => model.slug === target.model)),
    ),
  );
  const selectedModel = [
    ...input.mcp.engine.knowledgeScan.mainThreadModelPreference,
    ...(input.projectDefaultModel === undefined ? [] : [input.projectDefaultModel]),
  ].find((selection) => {
    const provider = preferredProvider(selection, usableProviders);
    return provider?.models.some((model) => model.slug === selection.model) ?? false;
  });
  return {
    engineKnowledgeEnabled: [
      input.mcp.engine.planning,
      input.mcp.engine.consensus,
      input.mcp.engine.enrich,
      input.mcp.engine.implement,
      input.mcp.engine.quality,
      input.mcp.engine.performance,
      input.mcp.engine.typescript,
    ].some(Boolean),
    availableScanners: availableScanners.map(
      (target) => `${target.provider}/${target.model ?? "provider-default"}`,
    ),
    ...(selectedModel === undefined ? {} : { selectedModel }),
  };
}

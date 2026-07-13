import type { SkillToggleProviderId, SkillToggleSettings } from "@t3tools/contracts";

export interface SkillToggleState {
  readonly enabled: boolean;
  readonly overriddenBy: "master" | "provider" | null;
}

export function resolveSkillToggleState(
  settings: SkillToggleSettings,
  providerId: SkillToggleProviderId,
  skillId: string,
): SkillToggleState {
  const provider = settings.providers[providerId];
  const overriddenBy = settings.disableAllProviders
    ? "master"
    : provider.disableAll
      ? "provider"
      : null;
  return {
    enabled: overriddenBy === null && !provider.disabledSkills.includes(skillId),
    overriddenBy,
  };
}

export function setSkillEnabled(
  settings: SkillToggleSettings,
  providerId: SkillToggleProviderId,
  skillId: string,
  enabled: boolean,
): SkillToggleSettings {
  const disabledSkills = new Set(settings.providers[providerId].disabledSkills);
  if (enabled) disabledSkills.delete(skillId);
  else disabledSkills.add(skillId);

  return {
    ...settings,
    providers: {
      ...settings.providers,
      [providerId]: {
        ...settings.providers[providerId],
        disabledSkills: [...disabledSkills].sort(),
      },
    },
  };
}

export function setProviderSkillsDisabled(
  settings: SkillToggleSettings,
  providerId: SkillToggleProviderId,
  disableAll: boolean,
): SkillToggleSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [providerId]: { ...settings.providers[providerId], disableAll },
    },
  };
}

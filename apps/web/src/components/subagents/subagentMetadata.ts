const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal reasoning",
  low: "Low reasoning",
  medium: "Medium reasoning",
  high: "High reasoning",
  xhigh: "Extra high reasoning",
};

export function reasoningEffortLabel(effort: string | null): string | null {
  if (!effort) return null;
  return REASONING_EFFORT_LABELS[effort] ?? `${effort} reasoning`;
}

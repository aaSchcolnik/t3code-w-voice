import type { ScannerReport } from "@t3tools/contracts";

export interface ScannerReportConflict {
  readonly table:
    | "project_profile"
    | "knowledge_entities"
    | "knowledge_relationships"
    | "rules"
    | "lessons_learned";
  readonly key: string;
  readonly scannerValues: ReadonlyArray<{ readonly scanner: string; readonly value: unknown }>;
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
const scannerId = (report: ScannerReport): string =>
  `${report.scanner.provider}/${report.scanner.model}`;
const fingerprint = (value: unknown): string => {
  const content = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

function mergeByKey<T>(input: {
  readonly table: ScannerReportConflict["table"];
  readonly rows: ReadonlyArray<{ readonly scanner: string; readonly key: string; readonly row: T }>;
  readonly substance: (row: T) => unknown;
  readonly toCandidate: (row: T, agreedBy: ReadonlyArray<string>) => Record<string, unknown>;
}): { rows: Array<Record<string, unknown>>; conflicts: Array<ScannerReportConflict> } {
  const groups = new Map<string, Array<{ scanner: string; row: T }>>();
  for (const item of input.rows) {
    const key = normalize(item.key);
    if (key.length === 0) continue;
    const group = groups.get(key) ?? [];
    group.push({ scanner: item.scanner, row: item.row });
    groups.set(key, group);
  }
  const rows: Array<Record<string, unknown>> = [];
  const conflicts: Array<ScannerReportConflict> = [];
  for (const [key, group] of groups) {
    const variants = new Map<string, typeof group>();
    for (const item of group) {
      const signature = JSON.stringify(input.substance(item.row));
      const variant = variants.get(signature) ?? [];
      variant.push(item);
      variants.set(signature, variant);
    }
    const winner = [...variants.values()].sort((a, b) => b.length - a.length)[0]!;
    const agreedBy = [...new Set(winner.map((item) => item.scanner))];
    rows.push(input.toCandidate(winner[0]!.row, agreedBy));
    if (variants.size > 1) {
      conflicts.push({
        table: input.table,
        key,
        scannerValues: group.map((item) => ({
          scanner: item.scanner,
          value: input.substance(item.row),
        })),
      });
    }
  }
  return { rows, conflicts };
}

export function mergeScannerReports(
  reports: ReadonlyArray<ScannerReport>,
  options: { readonly scanRunId?: string } = {},
) {
  const profile = mergeByKey({
    table: "project_profile",
    rows: reports.flatMap((report) =>
      report.profileFacts.map((row) => ({ scanner: scannerId(report), key: row.key, row })),
    ),
    substance: (row) => normalize(row.value),
    toCandidate: (row, agreedBy) => ({
      key: row.key,
      value: row.value,
      evidence: row.evidence,
      agreed_by: agreedBy,
    }),
  });
  const profileColumns = new Set([
    "framework",
    "language",
    "package_manager",
    "test_runner",
    "async_model",
    "state_management",
    "component_library",
    "styling",
    "i18n",
    "layer_model",
    "path_aliases",
    "file_suffix_conventions",
    "ticket_pattern",
    "default_branch",
  ]);
  const profileRow = profile.rows.reduce<Record<string, unknown>>(
    (result, row) => {
      const key = String(row.key);
      if (profileColumns.has(key)) result[key] = row.value;
      else
        result.notes = `${typeof result.notes === "string" ? `${result.notes}\n` : ""}${key}: ${String(row.value)}`;
      result.evidence = {
        ...(typeof result.evidence === "object" && result.evidence !== null ? result.evidence : {}),
        [key]: row.evidence,
      };
      result.agreed_by = [
        ...new Set([
          ...(Array.isArray(result.agreed_by) ? result.agreed_by.map(String) : []),
          ...(Array.isArray(row.agreed_by) ? row.agreed_by.map(String) : []),
        ]),
      ];
      return result;
    },
    { source: "bootstrap" },
  );
  const legacyEntities = reports.flatMap((report) => [
    ...(report.reusable_components ?? []).map((row) => ({
      scanner: scannerId(report),
      row: {
        key: `${row.path}#${row.exportName}`,
        category: "building-block" as const,
        kind: "component",
        name: row.exportName,
        summary: row.summary,
        locations: [row.path],
        publicApi: [],
        reuseWhen: row.reuseWhen,
        tags: [],
        metadata: {},
        evidence: row.evidence,
      },
    })),
    ...(report.features ?? []).map((row) => ({
      scanner: scannerId(report),
      row: {
        key: `feature:${row.slug}`,
        category: "capability" as const,
        kind: "feature",
        name: row.title,
        summary: row.summary,
        locations: row.paths,
        publicApi: [],
        reuseWhen: undefined,
        tags: [],
        metadata: {},
        evidence: row.evidence,
      },
    })),
  ]);
  const entities = mergeByKey({
    table: "knowledge_entities",
    rows: reports
      .flatMap((report) =>
        report.entities.map((row) => ({
          scanner: scannerId(report),
          key: row.key,
          row,
        })),
      )
      .concat(legacyEntities.map(({ scanner, row }) => ({ scanner, key: row.key, row }))),
    substance: (row) => ({
      category: row.category,
      kind: normalize(row.kind),
      summary: normalize(`${row.summary} ${row.reuseWhen ?? ""}`),
      locations: [...row.locations].sort(),
    }),
    toCandidate: (row, agreedBy) => ({
      entity_key: row.key,
      category: row.category,
      kind: row.kind,
      name: row.name,
      summary: row.summary,
      locations: row.locations,
      public_api: row.publicApi,
      reuse_guidance: row.reuseWhen,
      tags: row.tags,
      metadata: row.metadata,
      evidence: row.evidence,
      agreed_by: agreedBy,
      scan_run_id: options.scanRunId,
      content_fingerprint: fingerprint(row),
      stale: 0,
      source: "bootstrap",
    }),
  });
  const relationships = mergeByKey({
    table: "knowledge_relationships",
    rows: reports.flatMap((report) =>
      report.relationships.map((row) => ({
        scanner: scannerId(report),
        key: `${row.sourceKey}|${row.kind}|${row.targetKey}`,
        row,
      })),
    ),
    substance: (row) => ({ kind: normalize(row.kind), summary: normalize(row.summary ?? "") }),
    toCandidate: (row, agreedBy) => ({
      relationship_key: `${row.sourceKey}|${row.kind}|${row.targetKey}`,
      source_entity_key: row.sourceKey,
      target_entity_key: row.targetKey,
      kind: row.kind,
      summary: row.summary,
      metadata: row.metadata,
      evidence: row.evidence,
      agreed_by: agreedBy,
      scan_run_id: options.scanRunId,
      content_fingerprint: fingerprint(row),
      stale: 0,
      source: "bootstrap",
    }),
  });
  const rules = mergeByKey({
    table: "rules",
    rows: reports.flatMap((report) =>
      report.rules.map((row) => ({ scanner: scannerId(report), key: row.text, row })),
    ),
    substance: (row) => normalize(row.text),
    toCandidate: (row, agreedBy) => ({
      concern: "convention",
      risk: "medium",
      rule_text: row.text,
      gotchas: row.rationale === undefined ? [] : [row.rationale],
      imports: [],
      keywords: [],
      agreed_by: agreedBy,
      source: "bootstrap",
    }),
  });
  const lessons = mergeByKey({
    table: "lessons_learned",
    rows: reports.flatMap((report) =>
      report.lessons_learned.map((row) => ({ scanner: scannerId(report), key: row.title, row })),
    ),
    substance: (row) => normalize(row.detail),
    toCandidate: (row, agreedBy) => ({
      title: row.title,
      body: row.detail,
      category: "gotcha",
      scope_glob: row.scopePath,
      keywords: [],
      agreed_by: agreedBy,
      source: "bootstrap",
    }),
  });
  return {
    candidates: {
      project_profile: profile.rows.length > 0 ? [profileRow] : [],
      knowledge_entities: entities.rows,
      knowledge_relationships: relationships.rows,
      rules: rules.rows,
      lessons_learned: lessons.rows,
    },
    conflicts: [
      ...profile.conflicts,
      ...entities.conflicts,
      ...relationships.conflicts,
      ...rules.conflicts,
      ...lessons.conflicts,
    ],
    failures: reports.flatMap((report) =>
      report.failures.map((reason) => ({ scanner: scannerId(report), reason })),
    ),
  };
}

import type { ScannerReport } from "@t3tools/contracts";

export interface ScannerReportConflict {
  readonly table:
    | "project_profile"
    | "reusable_components"
    | "rules"
    | "lessons_learned"
    | "features";
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

export function mergeScannerReports(reports: ReadonlyArray<ScannerReport>) {
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
  const components = mergeByKey({
    table: "reusable_components",
    rows: reports.flatMap((report) =>
      report.reusable_components.map((row) => ({
        scanner: scannerId(report),
        key: `${row.path}:${row.exportName}`,
        row,
      })),
    ),
    substance: (row) => normalize(`${row.summary} ${row.reuseWhen ?? ""}`),
    toCandidate: (row, agreedBy) => ({
      name: row.exportName,
      kind: "component",
      import_path: row.path,
      summary: row.summary,
      when_to_use: row.reuseWhen,
      keywords: [],
      agreed_by: agreedBy,
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
  const features = mergeByKey({
    table: "features",
    rows: reports.flatMap((report) =>
      report.features.map((row) => ({ scanner: scannerId(report), key: row.slug, row })),
    ),
    substance: (row) => normalize(`${row.title} ${row.summary}`),
    toCandidate: (row, agreedBy) => ({
      key: row.slug,
      name: row.title,
      summary: row.summary,
      keywords: [],
      capabilities: row.paths,
      relationships: [],
      gotchas: [],
      when_touched_ask: [],
      agreed_by: agreedBy,
      source: "bootstrap",
    }),
  });
  return {
    candidates: {
      project_profile: profile.rows,
      reusable_components: components.rows,
      rules: rules.rows,
      lessons_learned: lessons.rows,
      features: features.rows,
    },
    conflicts: [
      ...profile.conflicts,
      ...components.conflicts,
      ...lessons.conflicts,
      ...features.conflicts,
    ],
    failures: reports.flatMap((report) =>
      report.failures.map((reason) => ({ scanner: scannerId(report), reason })),
    ),
  };
}

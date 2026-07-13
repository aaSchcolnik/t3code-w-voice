import {
  ArtifactKind,
  ImplementationCaseKind,
  KnowledgeTable,
  KnowledgeError,
  ProjectId,
  SearchableKnowledgeTable,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import angularSignalsPack from "./packs/angular-signals.json" with { type: "json" };
import genericPack from "./packs/generic.json" with { type: "json" };
import { KnowledgeDatabase, withProjectDatabase } from "./ProjectKnowledgeStore.ts";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const jsonColumns = new Set([
  "layer_model",
  "path_aliases",
  "file_suffix_conventions",
  "locations",
  "public_api",
  "metadata",
  "evidence",
  "props_or_api",
  "keywords",
  "tags",
  "gotchas",
  "imports",
  "capabilities",
  "relationships",
  "when_touched_ask",
  "stats",
  "agreed_by",
]);

const tableColumns: Record<KnowledgeTable, readonly string[]> = {
  project_profile: [
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
    "notes",
    "evidence",
    "agreed_by",
  ],
  knowledge_entities: [
    "entity_key",
    "category",
    "kind",
    "name",
    "summary",
    "locations",
    "public_api",
    "reuse_guidance",
    "tags",
    "metadata",
    "evidence",
    "consumer_count",
    "agreed_by",
    "scan_run_id",
    "content_fingerprint",
    "stale",
  ],
  knowledge_relationships: [
    "relationship_key",
    "source_entity_key",
    "target_entity_key",
    "kind",
    "summary",
    "metadata",
    "evidence",
    "agreed_by",
    "scan_run_id",
    "content_fingerprint",
    "stale",
  ],
  lessons_learned: ["title", "body", "category", "scope_glob", "keywords", "agreed_by"],
  rules: [
    "concern",
    "risk",
    "rule_text",
    "gotchas",
    "imports",
    "example_template",
    "keywords",
    "agreed_by",
  ],
  audit_rules: [
    "pack",
    "rule_id",
    "tier",
    "severity",
    "description",
    "detection_hint",
    "fix_guidance",
    "enabled",
    "agreed_by",
  ],
};

const searchColumns: Record<SearchableKnowledgeTable, readonly string[]> = {
  knowledge_entities: [
    "entity_key",
    "category",
    "kind",
    "name",
    "summary",
    "locations",
    "public_api",
    "reuse_guidance",
    "tags",
    "metadata",
  ],
  knowledge_relationships: [
    "relationship_key",
    "source_entity_key",
    "target_entity_key",
    "kind",
    "summary",
    "metadata",
  ],
  lessons_learned: ["title", "body", "category", "keywords", "scope_glob"],
  rules: ["concern", "rule_text", "gotchas", "keywords"],
  audit_rules: ["rule_id", "description", "detection_hint", "fix_guidance", "pack"],
};

const normalizeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      jsonColumns.has(key) && typeof value === "string"
        ? (() => {
            try {
              return decodeJson(value);
            } catch {
              return value;
            }
          })()
        : value,
    ]),
  );

const encodeValue = (column: string, value: unknown) =>
  jsonColumns.has(column) && typeof value !== "string" ? encodeJson(value) : value;

const hashContent = (content: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const knowledgeStatus = (projectId: ProjectId) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const profile = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM project_profile WHERE id = 1`;
      const counts: Record<string, number> = {};
      for (const table of Object.keys(tableColumns) as KnowledgeTable[]) {
        const rows = yield* sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${table}`,
        );
        counts[table] = Number(rows[0]?.count ?? 0);
      }
      const bootstrap = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM bootstrap_state ORDER BY completed_at`;
      return {
        profile: profile[0] ? normalizeRow(profile[0]) : null,
        counts,
        bootstrap: bootstrap.map(normalizeRow),
        needsBootstrap: !profile[0] && Object.values(counts).every((count) => count === 0),
      };
    }),
  );

export const searchKnowledge = (
  projectId: ProjectId,
  input: {
    table: SearchableKnowledgeTable;
    query: string;
    category?: string | undefined;
    scopePath?: string | undefined;
    limit?: number | undefined;
  },
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
      const columns = searchColumns[input.table];
      const haystack = columns.map((column) => `COALESCE(${column}, '')`).join(" || ' ' || ");
      const params: unknown[] = [];
      const termScores = terms.map(() => {
        params.push(`%${terms[params.length] ?? ""}%`);
        return `CASE WHEN lower(${haystack}) LIKE ? THEN 1 ELSE 0 END`;
      });
      const score = termScores.length > 0 ? termScores.join(" + ") : "1";
      const categoryFilter =
        input.table === "knowledge_entities" && input.category ? " AND category = ?" : "";
      const staleFilter =
        input.table === "knowledge_entities" || input.table === "knowledge_relationships"
          ? " AND stale = 0"
          : "";
      const where = terms.length > 0 ? `(${score}) > 0` : "1 = 1";
      const scopeFilter =
        input.table === "lessons_learned" && input.scopePath
          ? " AND (scope_glob IS NULL OR ? LIKE replace(scope_glob, '*', '%'))"
          : "";
      const scoreParams = [...params];
      const whereParams = [...params];
      const allParams = [...scoreParams, ...whereParams];
      if (categoryFilter) allParams.push(input.category);
      if (scopeFilter) allParams.push(input.scopePath);
      allParams.push(Math.min(input.limit ?? 20, 100));
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT *, (${score}) AS rank FROM ${input.table}
         WHERE status != 'rejected' AND ${where}${staleFilter}${categoryFilter}${scopeFilter}
         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, rank DESC, updated_at DESC
         LIMIT ?`,
        allParams,
      );
      return rows.map(normalizeRow);
    }),
  );

export const getKnowledge = (projectId: ProjectId, table: KnowledgeTable, id: string | number) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const key =
        table === "project_profile"
          ? "id"
          : table === "knowledge_entities" && typeof id === "string"
            ? "entity_key"
            : table === "knowledge_relationships" && typeof id === "string"
              ? "relationship_key"
              : "id";
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE ${key} = ? LIMIT 1`,
        [table === "project_profile" ? 1 : id],
      );
      return rows[0] ? normalizeRow(rows[0]) : null;
    }),
  );

export const saveKnowledge = (
  projectId: ProjectId,
  table: KnowledgeTable,
  rows: ReadonlyArray<Record<string, unknown>>,
  confirmed = false,
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const savedIds: Array<number | string> = [];
      for (const row of rows) {
        const columns = tableColumns[table].filter((column) => row[column] !== undefined);
        let status = confirmed ? "confirmed" : "proposed";
        let source = confirmed ? "user" : typeof row.source === "string" ? row.source : "agent";
        const values = columns.map((column) => encodeValue(column, row[column]));
        if (table === "project_profile") {
          const existing = yield* sql<{ readonly status: string; readonly source: string }>`
            SELECT status, source FROM project_profile WHERE id = 1
          `;
          if (!confirmed && existing[0]?.status === "confirmed") {
            status = "confirmed";
            source = existing[0].source;
          }
          const insertColumns = ["id", ...columns, "status", "source"];
          const updates = [...columns, "status", "source"]
            .map((column) => `${column} = excluded.${column}`)
            .join(", ");
          yield* sql.unsafe(
            `INSERT INTO project_profile (${insertColumns.join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})
             ON CONFLICT(id) DO UPDATE SET ${updates}, updated_at = CURRENT_TIMESTAMP`,
            [1, ...values, status, source],
          );
          savedIds.push(1);
          continue;
        }
        let id = typeof row.id === "number" ? row.id : undefined;
        if (id === undefined && source === "bootstrap") {
          const match =
            table === "knowledge_entities" && typeof row.entity_key === "string"
              ? yield* sql.unsafe<{
                  readonly id: number;
                  readonly status: string;
                  readonly source: string;
                }>(
                  "SELECT id, status, source FROM knowledge_entities WHERE entity_key = ? LIMIT 1",
                  [row.entity_key],
                )
              : table === "knowledge_relationships" && typeof row.relationship_key === "string"
                ? yield* sql.unsafe<{
                    readonly id: number;
                    readonly status: string;
                    readonly source: string;
                  }>(
                    "SELECT id, status, source FROM knowledge_relationships WHERE relationship_key = ? LIMIT 1",
                    [row.relationship_key],
                  )
                : table === "rules" && typeof row.rule_text === "string"
                  ? yield* sql.unsafe<{
                      readonly id: number;
                      readonly status: string;
                      readonly source: string;
                    }>(
                      "SELECT id, status, source FROM rules WHERE lower(trim(rule_text)) = lower(trim(?)) LIMIT 1",
                      [row.rule_text],
                    )
                  : table === "lessons_learned" && typeof row.title === "string"
                    ? yield* sql.unsafe<{
                        readonly id: number;
                        readonly status: string;
                        readonly source: string;
                      }>(
                        "SELECT id, status, source FROM lessons_learned WHERE lower(trim(title)) = lower(trim(?)) LIMIT 1",
                        [row.title],
                      )
                    : [];
          if (match[0]) {
            id = Number(match[0].id);
            if (!confirmed && match[0].status === "confirmed") {
              status = "confirmed";
              source = match[0].source;
            }
          }
        }
        if (id !== undefined) {
          if (columns.length > 0) {
            const refreshSeen =
              source === "bootstrap" &&
              (table === "knowledge_entities" || table === "knowledge_relationships")
                ? ", stale = 0, last_seen_at = CURRENT_TIMESTAMP"
                : "";
            yield* sql.unsafe(
              `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")}, status = ?, source = ?, updated_at = CURRENT_TIMESTAMP${refreshSeen} WHERE id = ?`,
              [...values, status, source, id],
            );
          }
          savedIds.push(id);
        } else {
          const insertColumns = [...columns, "status", "source"];
          yield* sql.unsafe(
            `INSERT INTO ${table} (${insertColumns.join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`,
            [...values, status, source],
          );
          const result = yield* sql<{ readonly id: number }>`SELECT last_insert_rowid() AS id`;
          savedIds.push(Number(result[0]?.id));
        }
      }
      return savedIds;
    }),
  );

export const importAuditPacks = (
  projectId: ProjectId,
  packs: ReadonlyArray<"generic" | "angular-signals">,
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      let imported = 0;
      for (const pack of new Set(packs)) {
        const rules = pack === "generic" ? genericPack : angularSignalsPack;
        for (const rule of rules) {
          yield* sql.unsafe(
            `INSERT INTO audit_rules (pack, rule_id, tier, severity, description, detection_hint, fix_guidance, enabled, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'confirmed', 'bootstrap')
             ON CONFLICT(pack, rule_id) DO UPDATE SET tier=excluded.tier, severity=excluded.severity,
             description=excluded.description, detection_hint=excluded.detection_hint,
             fix_guidance=excluded.fix_guidance, updated_at=CURRENT_TIMESTAMP`,
            [
              pack,
              rule.rule_id,
              rule.tier,
              rule.severity,
              rule.description,
              rule.detection_hint,
              rule.fix_guidance,
            ],
          );
          imported += 1;
        }
        yield* sql`INSERT INTO bootstrap_state (phase, stats) VALUES (${`audit-pack:${pack}`}, ${encodeJson({ rules: rules.length })})
          ON CONFLICT(phase) DO UPDATE SET completed_at=CURRENT_TIMESTAMP, stats=excluded.stats`;
      }
      return imported;
    }),
  );

export const recordKnowledgeScan = (
  projectId: ProjectId,
  stats: {
    readonly scanRunId: string;
    readonly reportCount: number;
    readonly conflictCount: number;
    readonly failureCount: number;
    readonly markMissingStale?: boolean;
  },
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      if (stats.markMissingStale !== false) {
        yield* sql`UPDATE knowledge_entities SET stale = 1, updated_at = CURRENT_TIMESTAMP
          WHERE source = 'bootstrap' AND (scan_run_id IS NULL OR scan_run_id != ${stats.scanRunId})`;
        yield* sql`UPDATE knowledge_relationships SET stale = 1, updated_at = CURRENT_TIMESTAMP
          WHERE source = 'bootstrap' AND (scan_run_id IS NULL OR scan_run_id != ${stats.scanRunId})`;
      }
      yield* sql`INSERT INTO bootstrap_state (phase, stats) VALUES ('knowledge-scan', ${encodeJson(stats)})
        ON CONFLICT(phase) DO UPDATE SET completed_at=CURRENT_TIMESTAMP, stats=excluded.stats`;
    }),
  );

export const openCase = (
  projectId: ProjectId,
  input: { caseSlug: string; title: string; kind: ImplementationCaseKind },
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      yield* sql`INSERT INTO implementation_cases (case_slug, title, kind) VALUES (${input.caseSlug}, ${input.title}, ${input.kind})
      ON CONFLICT(case_slug) DO UPDATE SET title=excluded.title, last_accessed_at=CURRENT_TIMESTAMP`;
      const cases = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM implementation_cases WHERE case_slug=${input.caseSlug}`;
      const artifacts = yield* sql<
        Record<string, unknown>
      >`SELECT id, kind, seq, title, format, updated_at FROM artifacts WHERE case_id=${cases[0]!.id} ORDER BY kind, seq`;
      return { ...normalizeRow(cases[0]!), artifacts: artifacts.map(normalizeRow) };
    }),
  );

export const saveArtifact = (
  projectId: ProjectId,
  input: {
    caseSlug: string;
    kind: ArtifactKind;
    seq?: number | undefined;
    title: string;
    format: "markdown" | "json" | "html";
    content: string;
  },
) => {
  if (new TextEncoder().encode(input.content).byteLength > MAX_ARTIFACT_BYTES) {
    return Effect.fail(
      new KnowledgeError({
        operation: "artifact-save",
        message: "Artifact exceeds the 1 MiB limit; split it into multiple sequenced artifacts.",
      }),
    );
  }
  return withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const cases = yield* sql<{
        readonly id: number;
      }>`SELECT id FROM implementation_cases WHERE case_slug=${input.caseSlug}`;
      const caseId = cases[0]?.id;
      if (caseId === undefined)
        return yield* new KnowledgeError({
          operation: "artifact-save",
          message: `Implementation case '${input.caseSlug}' does not exist.`,
        });
      const seq = input.seq ?? 0;
      yield* sql`INSERT INTO artifacts (case_id, kind, seq, title, format, content, content_hash)
      VALUES (${caseId}, ${input.kind}, ${seq}, ${input.title}, ${input.format}, ${input.content}, ${hashContent(input.content)})
      ON CONFLICT(case_id, kind, seq) DO UPDATE SET title=excluded.title, format=excluded.format,
      content=excluded.content, content_hash=excluded.content_hash, updated_at=CURRENT_TIMESTAMP,
      last_accessed_at=CURRENT_TIMESTAMP`;
      yield* sql`UPDATE implementation_cases SET last_accessed_at=CURRENT_TIMESTAMP WHERE id=${caseId}`;
      const rows = yield* sql<{
        readonly id: number;
      }>`SELECT id FROM artifacts WHERE case_id=${caseId} AND kind=${input.kind} AND seq=${seq}`;
      return { id: Number(rows[0]?.id), contentHash: hashContent(input.content) };
    }),
  );
};

export const getArtifact = (
  projectId: ProjectId,
  input: {
    id?: number | undefined;
    caseSlug?: string | undefined;
    kind?: ArtifactKind | undefined;
    seq?: number | undefined;
    headLines?: number | undefined;
  },
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const params: unknown[] = [];
      const where =
        input.id !== undefined
          ? (params.push(input.id), "a.id = ?")
          : (params.push(input.caseSlug ?? "", input.kind ?? "", input.seq ?? 0),
            "c.case_slug = ? AND a.kind = ? AND a.seq = ?");
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT a.*, c.case_slug FROM artifacts a JOIN implementation_cases c ON c.id=a.case_id WHERE ${where} LIMIT 1`,
        params,
      );
      const row = rows[0];
      if (!row) return null;
      yield* sql`UPDATE artifacts SET last_accessed_at=CURRENT_TIMESTAMP WHERE id=${row.id}`;
      yield* sql`UPDATE implementation_cases SET last_accessed_at=CURRENT_TIMESTAMP WHERE id=${row.case_id}`;
      const normalized = normalizeRow(row);
      if (input.headLines && typeof normalized.content === "string") {
        normalized.content = normalized.content.split("\n").slice(0, input.headLines).join("\n");
        normalized.truncated = normalized.content !== row.content;
      }
      return normalized;
    }),
  );

export const listArtifacts = (projectId: ProjectId, caseSlug?: string) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      if (caseSlug) {
        return yield* sql<
          Record<string, unknown>
        >`SELECT a.id, a.kind, a.seq, a.title, a.format, a.updated_at, a.last_accessed_at
        FROM artifacts a JOIN implementation_cases c ON c.id=a.case_id WHERE c.case_slug=${caseSlug} ORDER BY a.kind, a.seq`;
      }
      return yield* sql<Record<string, unknown>>`SELECT *,
      MAX(0, 21 - CAST(julianday('now') - julianday(last_accessed_at) AS INTEGER)) AS expires_in_days
      FROM implementation_cases ORDER BY last_accessed_at DESC`;
    }),
  );

export const queryKnowledge = (
  projectId: ProjectId,
  input: {
    table: KnowledgeTable;
    status?: string | undefined;
    query?: string | undefined;
    categories?: ReadonlyArray<string> | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  },
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (input.status) {
        clauses.push("status = ?");
        params.push(input.status);
      }
      if (input.table === "knowledge_entities" && input.categories?.length) {
        clauses.push(`category IN (${input.categories.map(() => "?").join(",")})`);
        params.push(...input.categories);
      }
      if (input.query?.trim()) {
        const columns =
          input.table === "project_profile"
            ? tableColumns.project_profile
            : (searchColumns[input.table as SearchableKnowledgeTable] ?? tableColumns[input.table]);
        clauses.push(
          `lower(${columns.map((column) => `COALESCE(${column}, '')`).join(" || ' ' || ")}) LIKE ?`,
        );
        params.push(`%${input.query.trim().toLowerCase()}%`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const countRows = yield* sql.unsafe<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM ${input.table} ${where}`,
        params,
      );
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM ${input.table} ${where} ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, updated_at DESC LIMIT ? OFFSET ?`,
        [...params, input.limit ?? 50, input.offset ?? 0],
      );
      return { rows: rows.map(normalizeRow), total: Number(countRows[0]?.count ?? 0) };
    }),
  );

export const setKnowledgeStatus = (
  projectId: ProjectId,
  table: KnowledgeTable,
  ids: ReadonlyArray<string | number>,
  status: "proposed" | "confirmed" | "rejected",
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      if (ids.length === 0) return 0;
      const key =
        table === "project_profile"
          ? "id"
          : table === "knowledge_entities" && ids.some((id) => typeof id === "string")
            ? "entity_key"
            : table === "knowledge_relationships" && ids.some((id) => typeof id === "string")
              ? "relationship_key"
              : "id";
      yield* sql.unsafe(
        `UPDATE ${table} SET status = ?, source = 'user', updated_at = CURRENT_TIMESTAMP WHERE ${key} IN (${ids.map(() => "?").join(",")})`,
        [status, ...ids.map((id) => (table === "project_profile" ? 1 : id))],
      );
      return ids.length;
    }),
  );

export const deleteKnowledgeRow = (
  projectId: ProjectId,
  table: KnowledgeTable,
  id: string | number,
) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      const key =
        table === "project_profile"
          ? "id"
          : table === "knowledge_entities" && typeof id === "string"
            ? "entity_key"
            : table === "knowledge_relationships" && typeof id === "string"
              ? "relationship_key"
              : "id";
      yield* sql.unsafe(`DELETE FROM ${table} WHERE ${key} = ?`, [
        table === "project_profile" ? 1 : id,
      ]);
      return true;
    }),
  );

export const deleteCase = (projectId: ProjectId, caseSlug: string) =>
  withProjectDatabase(
    projectId,
    Effect.gen(function* () {
      const { sql } = yield* KnowledgeDatabase;
      yield* sql`DELETE FROM implementation_cases WHERE case_slug=${caseSlug}`;
      return true;
    }),
  );

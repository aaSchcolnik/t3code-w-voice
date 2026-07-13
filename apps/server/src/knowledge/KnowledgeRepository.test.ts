import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  getArtifact,
  getKnowledge,
  importAuditPacks,
  knowledgeStatus,
  openCase,
  saveArtifact,
  saveKnowledge,
  searchKnowledge,
  queryKnowledge,
  setKnowledgeStatus,
  deleteKnowledgeRow,
  deleteCase,
} from "./KnowledgeRepository.ts";
import {
  KnowledgeDatabase,
  ProjectKnowledgeStore,
  withProjectDatabase,
} from "./ProjectKnowledgeStore.ts";
import { mergeScannerReports } from "./mergeScannerReports.ts";

const layer = ProjectKnowledgeStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-knowledge-repo-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("KnowledgeRepository", (it) => {
  it.effect("supports proposed and confirmed knowledge with ranked search", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("search-project");
      const [firstId] = yield* saveKnowledge(projectId, "lessons_learned", [
        {
          title: "Prefer scoped resources",
          body: "Database handles must close with their scope",
          category: "prefer",
          keywords: ["database", "scope"],
        },
      ]);
      yield* saveKnowledge(projectId, "lessons_learned", [
        {
          title: "Unrelated lesson",
          body: "CSS naming",
          category: "gotcha",
          keywords: ["css"],
        },
      ]);

      const proposed = yield* getKnowledge(projectId, "lessons_learned", firstId!);
      expect(proposed?.status).toBe("proposed");
      yield* saveKnowledge(projectId, "lessons_learned", [{ ...proposed, id: firstId }], true);
      const matches = yield* searchKnowledge(projectId, {
        table: "lessons_learned",
        query: "database scope",
        limit: 5,
      });
      expect(matches[0]?.title).toBe("Prefer scoped resources");
      expect(matches[0]?.status).toBe("confirmed");
    }),
  );

  it.effect("imports audit packs idempotently and reports bootstrap status", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("bootstrap-project");
      expect(yield* importAuditPacks(projectId, ["generic", "angular-signals"])).toBe(14);
      yield* importAuditPacks(projectId, ["generic"]);
      const status = yield* knowledgeStatus(projectId);
      expect(status.counts.audit_rules).toBe(14);
      expect(status.bootstrap).toHaveLength(2);
    }),
  );

  it.effect("persists artifacts, truncates reads, and rescues cases from TTL expiry", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("artifact-project");
      yield* openCase(projectId, { caseSlug: "feature-a", title: "Feature A", kind: "implement" });
      const saved = yield* saveArtifact(projectId, {
        caseSlug: "feature-a",
        kind: "plan",
        title: "Plan",
        format: "markdown",
        content: "line one\nline two\nline three",
      });
      yield* withProjectDatabase(
        projectId,
        Effect.gen(function* () {
          const { sql } = yield* KnowledgeDatabase;
          yield* sql`UPDATE implementation_cases SET last_accessed_at=datetime('now', '-22 days') WHERE case_slug='feature-a'`;
          yield* sql`UPDATE artifacts SET last_accessed_at=datetime('now', '-22 days') WHERE id=${saved.id}`;
        }),
      );

      const artifact = yield* getArtifact(projectId, { id: saved.id, headLines: 2 });
      expect(artifact?.content).toBe("line one\nline two");
      expect(artifact?.truncated).toBe(true);
      const purged = yield* withProjectDatabase(
        projectId,
        Effect.gen(function* () {
          const database = yield* KnowledgeDatabase;
          return yield* database.sweepExpiredArtifacts;
        }),
      );
      expect(purged).toBe(0);
    }),
  );

  it.effect("supports paginated review, bulk status changes, and manual deletion", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("review-project");
      const ids = yield* saveKnowledge(projectId, "rules", [
        { concern: "reliability", risk: "high", rule_text: "Preserve partial streams" },
        { concern: "performance", risk: "medium", rule_text: "Bound queued work" },
      ]);
      const pending = yield* queryKnowledge(projectId, {
        table: "rules",
        status: "proposed",
        limit: 1,
      });
      expect(pending.total).toBe(2);
      expect(pending.rows).toHaveLength(1);
      yield* setKnowledgeStatus(projectId, "rules", ids, "confirmed");
      expect(
        (yield* queryKnowledge(projectId, { table: "rules", status: "confirmed" })).total,
      ).toBe(2);
      yield* deleteKnowledgeRow(projectId, "rules", ids[0]!);
      expect((yield* queryKnowledge(projectId, { table: "rules" })).total).toBe(1);

      yield* openCase(projectId, {
        caseSlug: "delete-me",
        title: "Delete me",
        kind: "report-only",
      });
      yield* deleteCase(projectId, "delete-me");
      const cases = yield* withProjectDatabase(
        projectId,
        Effect.gen(function* () {
          const { sql } = yield* KnowledgeDatabase;
          return yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM implementation_cases`;
        }),
      );
      expect(Number(cases[0]?.count)).toBe(0);
    }),
  );

  it.effect("persists merged scanner provenance on proposed knowledge", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("scanner-provenance-project");
      const base = {
        profileFacts: [],
        rules: [],
        lessons_learned: [],
        features: [],
        failures: [],
      } as const;
      const merged = mergeScannerReports([
        {
          ...base,
          scanner: { provider: "codex", model: "terra" },
          reusable_components: [
            {
              path: "src/Button.tsx",
              exportName: "Button",
              summary: "Shared button",
              evidence: [],
            },
          ],
        },
        {
          ...base,
          scanner: { provider: "cursor", model: "grok" },
          reusable_components: [
            {
              path: "src/Button.tsx",
              exportName: "Button",
              summary: "Shared button",
              evidence: [],
            },
          ],
        },
      ]);
      yield* saveKnowledge(projectId, "reusable_components", merged.candidates.reusable_components);
      const queried = yield* queryKnowledge(projectId, {
        table: "reusable_components",
        status: "proposed",
      });
      expect(queried.rows[0]?.agreed_by).toEqual(["codex/terra", "cursor/grok"]);
      expect(queried.rows[0]?.source).toBe("bootstrap");
    }),
  );

  it.effect("makes bootstrap re-scans idempotent without downgrading confirmed rows", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("idempotent-scan-project");
      const row = {
        name: "Button",
        kind: "component",
        import_path: "src/Button.tsx",
        summary: "Initial summary",
        source: "bootstrap",
      };
      const [id] = yield* saveKnowledge(projectId, "reusable_components", [row]);
      yield* setKnowledgeStatus(projectId, "reusable_components", [id!], "confirmed");
      const [rescannedId] = yield* saveKnowledge(projectId, "reusable_components", [
        { ...row, summary: "Refreshed summary", agreed_by: ["codex/terra"] },
      ]);
      expect(rescannedId).toBe(id);
      const queried = yield* queryKnowledge(projectId, { table: "reusable_components" });
      expect(queried.total).toBe(1);
      expect(queried.rows[0]?.status).toBe("confirmed");
      expect(queried.rows[0]?.summary).toBe("Refreshed summary");
    }),
  );
});

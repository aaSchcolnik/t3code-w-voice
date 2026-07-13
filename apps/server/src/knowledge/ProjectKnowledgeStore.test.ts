import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  KnowledgeDatabase,
  ProjectKnowledgeStore,
  withProjectDatabase,
} from "./ProjectKnowledgeStore.ts";

const testLayer = ProjectKnowledgeStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-knowledge-store-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("ProjectKnowledgeStore", (it) => {
  it.effect("migrates databases and isolates projects", () =>
    Effect.gen(function* () {
      const first = ProjectId.make("project-a");
      const second = ProjectId.make("project-b");

      yield* withProjectDatabase(
        first,
        Effect.gen(function* () {
          const { sql } = yield* KnowledgeDatabase;
          yield* sql`INSERT INTO lessons_learned (title, body, category) VALUES ('A', 'only A', 'prefer')`;
        }),
      );

      const counts = yield* Effect.all(
        [first, second].map((projectId) =>
          withProjectDatabase(
            projectId,
            Effect.gen(function* () {
              const { sql } = yield* KnowledgeDatabase;
              const rows = yield* sql<{
                readonly count: number;
              }>`SELECT COUNT(*) AS count FROM lessons_learned`;
              return Number(rows[0]?.count ?? 0);
            }),
          ),
        ),
      );
      expect(counts).toEqual([1, 0]);
    }),
  );

  it.effect("purges only expired artifact cases", () =>
    withProjectDatabase(
      ProjectId.make("ttl-project"),
      Effect.gen(function* () {
        const database = yield* KnowledgeDatabase;
        const { sql } = database;
        yield* sql`INSERT INTO lessons_learned (title, body, category) VALUES ('Keep', 'knowledge', 'gotcha')`;
        yield* sql`INSERT INTO implementation_cases (case_slug, title, kind, last_accessed_at) VALUES ('expired', 'Expired', 'plan', datetime('now', '-22 days'))`;
        yield* sql`INSERT INTO implementation_cases (case_slug, title, kind) VALUES ('fresh', 'Fresh', 'plan')`;
        yield* sql`INSERT INTO artifacts (case_id, kind, seq, title, format, content, content_hash)
          SELECT id, 'plan', 0, 'Plan', 'markdown', '# Plan', 'hash' FROM implementation_cases WHERE case_slug = 'expired'`;

        expect(yield* database.sweepExpiredArtifacts).toBe(1);
        const cases = yield* sql<{
          readonly case_slug: string;
        }>`SELECT case_slug FROM implementation_cases ORDER BY case_slug`;
        const artifacts = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM artifacts`;
        const lessons = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM lessons_learned`;
        expect(cases.map((row) => row.case_slug)).toEqual(["fresh"]);
        expect(Number(artifacts[0]?.count)).toBe(0);
        expect(Number(lessons[0]?.count)).toBe(1);
      }),
    ),
  );
});

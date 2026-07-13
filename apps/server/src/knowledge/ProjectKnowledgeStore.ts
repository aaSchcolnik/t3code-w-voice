import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../config.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import migrateInitial from "./Migrations/001_InitialKnowledgeSchema.ts";
import migrateScanProvenance from "./Migrations/002_ScanProvenance.ts";

export const ARTIFACT_TTL_DAYS = 21;
export const PROJECT_KNOWLEDGE_IDLE_TTL = "10 minutes";

export interface KnowledgeDatabaseShape {
  readonly projectId: ProjectId;
  readonly sql: SqlClient.SqlClient;
  readonly sweepExpiredArtifacts: Effect.Effect<number, SqlError>;
}

export class KnowledgeDatabase extends Context.Service<KnowledgeDatabase, KnowledgeDatabaseShape>()(
  "t3/knowledge/ProjectKnowledgeStore/KnowledgeDatabase",
) {}

const sweep = Effect.fn("KnowledgeDatabase.sweepExpiredArtifacts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deleted = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM implementation_cases
    WHERE last_accessed_at < datetime('now', ${`-${ARTIFACT_TTL_DAYS} days`})
  `;
  const count = Number(deleted[0]?.count ?? 0);
  if (count > 0) {
    yield* sql`
      DELETE FROM implementation_cases
      WHERE last_accessed_at < datetime('now', ${`-${ARTIFACT_TTL_DAYS} days`})
    `;
    yield* sql.unsafe("PRAGMA optimize").unprepared;
    yield* Effect.logInfo("Purged expired Implementation Engine artifacts", { caseCount: count });
  }
  return count;
});

const databaseLayer = (projectId: ProjectId) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.knowledgeDir, { recursive: true });
      const filename = path.join(config.knowledgeDir, `${projectId}.sqlite`);
      const sqlite = makeRuntimeSqliteLayer({
        filename,
        spanAttributes: { "db.name": `${projectId}.sqlite`, "service.name": "t3-knowledge" },
      });
      const initialized = Layer.effect(
        KnowledgeDatabase,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
          yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
          yield* migrateInitial;
          yield* migrateScanProvenance;
          const sweepExpiredArtifacts = sweep().pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          yield* sweepExpiredArtifacts;
          yield* sweepExpiredArtifacts.pipe(
            Effect.repeat(Schedule.spaced("1 day")),
            Effect.forkScoped,
          );
          return KnowledgeDatabase.of({ projectId, sql, sweepExpiredArtifacts });
        }),
      );
      return initialized.pipe(Layer.provideMerge(sqlite));
    }),
  );

export class ProjectKnowledgeStore extends LayerMap.Service<ProjectKnowledgeStore>()(
  "t3/knowledge/ProjectKnowledgeStore",
  {
    lookup: (projectId: ProjectId) => databaseLayer(projectId),
    idleTimeToLive: PROJECT_KNOWLEDGE_IDLE_TTL,
  },
) {}

export const forProject = (projectId: ProjectId) => ProjectKnowledgeStore.get(projectId);

export const withProjectDatabase = <A, E, R>(
  projectId: ProjectId,
  effect: Effect.Effect<A, E, R | KnowledgeDatabase>,
) => effect.pipe(Effect.provide(forProject(projectId)));

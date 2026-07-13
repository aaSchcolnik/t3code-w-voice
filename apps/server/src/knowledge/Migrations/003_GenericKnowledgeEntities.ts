import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  `CREATE TABLE IF NOT EXISTS knowledge_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    locations TEXT NOT NULL DEFAULT '[]',
    public_api TEXT NOT NULL DEFAULT '[]',
    reuse_guidance TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    consumer_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    agreed_by TEXT NOT NULL DEFAULT '[]',
    scan_run_id TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    content_fingerprint TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relationship_key TEXT NOT NULL UNIQUE,
    source_entity_key TEXT NOT NULL,
    target_entity_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    agreed_by TEXT NOT NULL DEFAULT '[]',
    scan_run_id TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    content_fingerprint TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_entities_category_status
    ON knowledge_entities(category, status, stale)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_entities_kind ON knowledge_entities(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_source
    ON knowledge_relationships(source_entity_key, kind, stale)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_target
    ON knowledge_relationships(target_entity_key, kind, stale)`,
  `INSERT OR IGNORE INTO knowledge_entities (
    entity_key, category, kind, name, summary, locations, public_api, reuse_guidance,
    tags, consumer_count, status, source, agreed_by, first_seen_at, last_seen_at,
    created_at, updated_at
  )
  SELECT import_path || '#' || name, 'building-block', kind, name, summary,
    json_array(import_path), props_or_api, when_to_use, keywords, consumer_count,
    status, source, agreed_by, created_at, updated_at, created_at, updated_at
  FROM reusable_components`,
  `INSERT OR IGNORE INTO knowledge_entities (
    entity_key, category, kind, name, summary, locations, tags, metadata, status,
    source, agreed_by, first_seen_at, last_seen_at, created_at, updated_at
  )
  SELECT 'feature:' || key, 'capability', 'feature', name, summary, capabilities,
    keywords, json_object('relationships', json(relationships), 'gotchas', json(gotchas),
      'whenTouchedAsk', json(when_touched_ask)), status, source, agreed_by,
    created_at, updated_at, created_at, updated_at
  FROM features`,
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profileColumns = yield* sql.unsafe<{ readonly name: string }>(
    "PRAGMA table_info(project_profile)",
  );
  if (!profileColumns.some((column) => column.name === "evidence")) {
    yield* sql.unsafe("ALTER TABLE project_profile ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}'")
      .unprepared;
  }
  for (const statement of statements) {
    yield* sql.unsafe(statement).unprepared;
  }
});

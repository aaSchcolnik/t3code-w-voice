import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  `CREATE TABLE IF NOT EXISTS project_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1), framework TEXT, language TEXT, package_manager TEXT,
    test_runner TEXT, async_model TEXT, state_management TEXT, component_library TEXT,
    styling TEXT, i18n TEXT, layer_model TEXT NOT NULL DEFAULT '{}', path_aliases TEXT NOT NULL DEFAULT '{}',
    file_suffix_conventions TEXT NOT NULL DEFAULT '{}', ticket_pattern TEXT, default_branch TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS reusable_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, import_path TEXT NOT NULL,
    summary TEXT NOT NULL, when_to_use TEXT, props_or_api TEXT NOT NULL DEFAULT '{}', example_snippet TEXT,
    keywords TEXT NOT NULL DEFAULT '[]', consumer_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, import_path)
  )`,
  `CREATE TABLE IF NOT EXISTS lessons_learned (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('never-do','prefer','gotcha','debugging')),
    scope_glob TEXT, keywords TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, concern TEXT NOT NULL, risk TEXT NOT NULL CHECK(risk IN ('high','medium','low')),
    rule_text TEXT NOT NULL, gotchas TEXT NOT NULL DEFAULT '[]', imports TEXT NOT NULL DEFAULT '[]',
    example_template TEXT, keywords TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS audit_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT NOT NULL, rule_id TEXT NOT NULL, tier INTEGER NOT NULL CHECK(tier IN (1,2)),
    severity TEXT NOT NULL, description TEXT NOT NULL, detection_hint TEXT NOT NULL, fix_guidance TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'bootstrap' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pack, rule_id)
  )`,
  `CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, summary TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', capabilities TEXT NOT NULL DEFAULT '[]', relationships TEXT NOT NULL DEFAULT '[]',
    gotchas TEXT NOT NULL DEFAULT '[]', when_touched_ask TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('bootstrap','agent','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS bootstrap_state (
    phase TEXT PRIMARY KEY, completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, stats TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS implementation_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('plan-brief','plan','implement','audit','pr-review','hot-loops','report-only')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES implementation_cases(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('markdown','json','html')),
    content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, kind, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cases_last_accessed ON implementation_cases(last_accessed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_case ON artifacts(case_id, kind, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_components_status ON reusable_components(status)`,
  `CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons_learned(status)`,
  `CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status)`,
  `CREATE INDEX IF NOT EXISTS idx_features_status ON features(status)`,
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) {
    yield* sql.unsafe(statement).unprepared;
  }
});

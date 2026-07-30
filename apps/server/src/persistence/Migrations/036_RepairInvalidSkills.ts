import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import ProjectSkills from "./035_ProjectSkills.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const skillColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(skills)
  `;

  // Upstream now owns migration 35. Databases that reached that migration
  // before switching to this branch skip our migrations 33-35, so establish
  // the complete project-skills schema before applying the repair.
  if (!skillColumns.some((column) => column.name === "project_id")) {
    yield* ProjectSkills;
  }

  yield* sql`
    UPDATE skills
    SET active_version = (
      SELECT MAX(version)
      FROM skill_versions
      WHERE skill_versions.skill_id = skills.skill_id
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM skill_versions
      WHERE skill_versions.skill_id = skills.skill_id
        AND skill_versions.version = skills.active_version
    )
      AND EXISTS (
        SELECT 1
        FROM skill_versions
        WHERE skill_versions.skill_id = skills.skill_id
      )
  `;

  yield* sql`
    DELETE FROM skills
    WHERE NOT EXISTS (
      SELECT 1
      FROM skill_versions
      WHERE skill_versions.skill_id = skills.skill_id
    )
  `;
});

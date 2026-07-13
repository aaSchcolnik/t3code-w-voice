import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

import ReconcileLayeredProjectionSchema from "./038_ReconcileLayeredProjectionSchema.ts";

// Migration 38 was already recorded by some layered branch builds before it
// reconciled the upstream snooze columns. Run the idempotent reconciliation
// under a new migration ID so those databases receive the complete schema.
export default ReconcileLayeredProjectionSchema;

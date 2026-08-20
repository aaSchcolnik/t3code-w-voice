import * as Schema from "effect/Schema";
import { MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Client-side id for the first shell opened on a thread. Ids are uniformly
 * `term-N`; there's no "default" intrinsic. Kept as a named constant so callers
 * that want "the primary shell" don't hardcode `"term-1"`.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
});
export type TerminalAttachInput = Schema.Codec.Encoded<typeof TerminalAttachInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
});
export type TerminalSummary = typeof TerminalSummary.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;

export const TERMINAL_EXEC_MAX_COMMAND_CHARS = 32_768;
export const TERMINAL_EXEC_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const TERMINAL_EXEC_MAX_STREAM_CHARS = 32_768;
export const TERMINAL_EXEC_MAX_READ_CHARS = 256 * 1_024;

const TerminalExecutionId = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));

export const TerminalCommandStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
export type TerminalCommandStatus = typeof TerminalCommandStatus.Type;

/** Durable, bounded lifecycle data stored on a system timeline message. */
export const TerminalCommandRecord = Schema.Struct({
  executionId: TerminalExecutionId,
  command: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(TERMINAL_EXEC_MAX_COMMAND_CHARS),
  ),
  cwd: TrimmedNonEmptyStringSchema,
  status: TerminalCommandStatus,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  excerpt: Schema.String,
  truncated: Schema.Boolean,
  logBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  consumedAt: Schema.NullOr(Schema.String),
  stale: Schema.optional(Schema.Boolean),
});
export type TerminalCommandRecord = typeof TerminalCommandRecord.Type;

export const TerminalExecStartInput = Schema.Struct({
  threadId: ThreadId,
  executionId: TerminalExecutionId,
  messageId: MessageId,
  command: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(TERMINAL_EXEC_MAX_COMMAND_CHARS),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(TERMINAL_EXEC_MAX_TIMEOUT_MS),
    ),
  ),
});
export type TerminalExecStartInput = typeof TerminalExecStartInput.Type;

export const TerminalExecAttachInput = Schema.Struct({
  threadId: ThreadId,
  executionId: TerminalExecutionId,
  afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TerminalExecAttachInput = typeof TerminalExecAttachInput.Type;

export const TerminalExecCancelInput = Schema.Struct({
  threadId: ThreadId,
  executionId: TerminalExecutionId,
});
export type TerminalExecCancelInput = typeof TerminalExecCancelInput.Type;

export const TerminalExecReadOutputInput = Schema.Struct({
  threadId: ThreadId,
  executionId: TerminalExecutionId,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TerminalExecReadOutputInput = typeof TerminalExecReadOutputInput.Type;

export const TerminalExecReadOutputResult = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(TERMINAL_EXEC_MAX_READ_CHARS)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eof: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type TerminalExecReadOutputResult = typeof TerminalExecReadOutputResult.Type;

const TerminalExecEventBase = Schema.Struct({
  threadId: ThreadId,
  executionId: TerminalExecutionId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const TerminalExecSnapshotEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("snapshot"),
  record: TerminalCommandRecord,
  tail: Schema.String,
});

export const TerminalExecOutputEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String.check(Schema.isMaxLength(TERMINAL_EXEC_MAX_STREAM_CHARS)),
});

export const TerminalExecStatusEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("status"),
  record: TerminalCommandRecord,
});

export const TerminalExecStreamEvent = Schema.Union([
  TerminalExecSnapshotEvent,
  TerminalExecOutputEvent,
  TerminalExecStatusEvent,
]);
export type TerminalExecStreamEvent = typeof TerminalExecStreamEvent.Type;

export class TerminalExecNotFoundError extends Schema.TaggedErrorClass<TerminalExecNotFoundError>()(
  "TerminalExecNotFoundError",
  { threadId: ThreadId, executionId: TerminalExecutionId },
) {
  override get message() {
    return `Terminal command '${this.executionId}' was not found on thread '${this.threadId}'.`;
  }
}

export class TerminalExecConflictError extends Schema.TaggedErrorClass<TerminalExecConflictError>()(
  "TerminalExecConflictError",
  { threadId: ThreadId, executionId: TerminalExecutionId, detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export class TerminalExecThreadBusyError extends Schema.TaggedErrorClass<TerminalExecThreadBusyError>()(
  "TerminalExecThreadBusyError",
  { threadId: ThreadId, detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export class TerminalExecThreadNotFoundError extends Schema.TaggedErrorClass<TerminalExecThreadNotFoundError>()(
  "TerminalExecThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message() {
    return `Thread '${this.threadId}' must exist before running a terminal command.`;
  }
}

export class TerminalExecFailure extends Schema.TaggedErrorClass<TerminalExecFailure>()(
  "TerminalExecFailure",
  {
    threadId: ThreadId,
    executionId: TerminalExecutionId,
    operation: Schema.Literals(["start", "persist", "attach", "cancel", "read", "cleanup"]),
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}

export const TerminalExecError = Schema.Union([
  TerminalExecNotFoundError,
  TerminalExecConflictError,
  TerminalExecThreadBusyError,
  TerminalExecThreadNotFoundError,
  TerminalExecFailure,
]);
export type TerminalExecError = typeof TerminalExecError.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedErrorClass<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedErrorClass<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedErrorClass<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedErrorClass<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedErrorClass<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedErrorClass<TerminalWriteError>()(
  "TerminalWriteError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedErrorClass<TerminalResizeError>()(
  "TerminalResizeError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = typeof TerminalError.Type;

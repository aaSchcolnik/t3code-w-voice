import * as Schema from "effect/Schema";

export const ComputerUseCaptureStartInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  sourceGeneration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  target: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("app"),
      appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      appName: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    }),
    Schema.Struct({ kind: Schema.Literal("desktop") }),
  ]),
});
export type ComputerUseCaptureStartInput = typeof ComputerUseCaptureStartInput.Type;

export interface ComputerUseCaptureBridge {
  getCapability(): Promise<{
    ownerToken: string | null;
    platform: "darwin" | "linux" | "unsupported";
    available: boolean;
    reason?: string;
  }>;
  start(input: ComputerUseCaptureStartInput): Promise<{
    captureId: string;
    sourceId: string;
    appName?: string;
    scope: "window" | "desktop";
  }>;
  stop(captureId: string): Promise<void>;
}

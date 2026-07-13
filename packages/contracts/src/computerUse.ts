import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ComputerUseReadinessState = Schema.Literals([
  "unsupported",
  "provider-disabled",
  "provider-unavailable",
  "skill-missing",
  "skill-disabled",
  "node-repl-missing",
  "node-repl-disabled",
  "node-repl-startup-failed",
  "node-repl-tool-missing",
  "host-app-missing",
  "plugin-runtime-missing",
  "ready-unverified",
  "verified",
]);
export type ComputerUseReadinessState = typeof ComputerUseReadinessState.Type;

export const ComputerUseRemediation = Schema.Literals([
  "install-host-app",
  "enable-codex-provider",
  "install-enable-plugin",
  "enable-plugin-capabilities",
  "enable-node-repl",
  "repair-plugin-runtime",
  "grant-accessibility",
  "grant-screen-recording",
  "allow-required-applications",
  "start-new-session",
  "retry-test",
]);
export type ComputerUseRemediation = typeof ComputerUseRemediation.Type;

export const ComputerUseSkillState = Schema.Literals(["available", "missing", "disabled"]);
export type ComputerUseSkillState = typeof ComputerUseSkillState.Type;

export const ComputerUseNodeReplState = Schema.Literals([
  "available",
  "missing",
  "disabled",
  "startup-failed",
  "tool-missing",
]);
export type ComputerUseNodeReplState = typeof ComputerUseNodeReplState.Type;

export const ComputerUseAssetState = Schema.Literals(["available", "missing", "unknown"]);
export type ComputerUseAssetState = typeof ComputerUseAssetState.Type;

export const ComputerUsePermissionState = Schema.Literals(["unverified", "verified", "failed"]);
export type ComputerUsePermissionState = typeof ComputerUsePermissionState.Type;

export const ComputerUseProviderStatus = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerDisplayName: Schema.String,
  readiness: ComputerUseReadinessState,
  skill: ComputerUseSkillState,
  nodeRepl: ComputerUseNodeReplState,
  hostApp: ComputerUseAssetState,
  pluginRuntime: ComputerUseAssetState,
  nativePermissions: ComputerUsePermissionState,
  requiresNewSession: Schema.Boolean,
  remediation: Schema.Array(ComputerUseRemediation),
});
export type ComputerUseProviderStatus = typeof ComputerUseProviderStatus.Type;

export const ComputerUseStatusResult = Schema.Struct({
  providers: Schema.Array(ComputerUseProviderStatus),
});
export type ComputerUseStatusResult = typeof ComputerUseStatusResult.Type;

export const ComputerUseStatusInput = Schema.Struct({
  cwd: Schema.optional(Schema.String),
});
export type ComputerUseStatusInput = typeof ComputerUseStatusInput.Type;

export const ComputerUseTestInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.optional(Schema.String),
});
export type ComputerUseTestInput = typeof ComputerUseTestInput.Type;

export const ComputerUseTestFailureCategory = Schema.Literals([
  "unsupported-platform",
  "provider-unavailable",
  "skill-missing",
  "skill-disabled",
  "node-repl-missing",
  "node-repl-disabled",
  "node-repl-startup-failed",
  "node-repl-tool-missing",
  "host-app-missing",
  "plugin-runtime-missing",
  "runtime-initialization-failed",
  "app-discovery-failed",
  "target-app-not-found",
  "accessibility-permission-denied",
  "accessibility-unavailable",
  "screen-recording-permission-denied",
  "screenshot-unavailable",
  "native-service-failed",
  "unknown",
]);
export type ComputerUseTestFailureCategory = typeof ComputerUseTestFailureCategory.Type;

export const ComputerUseTargetKind = Schema.Literals([
  "t3-packaged",
  "t3-electron-dev",
  "not-found",
]);
export type ComputerUseTargetKind = typeof ComputerUseTargetKind.Type;

export const ComputerUseDiagnosticMetadata = Schema.Struct({
  runtimeInitialized: Schema.Boolean,
  appDiscoverySucceeded: Schema.Boolean,
  discoveredAppCount: NonNegativeInt,
  targetAppFound: Schema.Boolean,
  targetKind: ComputerUseTargetKind,
  accessibilityAvailable: Schema.Boolean,
  accessibilityTextLength: NonNegativeInt,
  screenshotAvailable: Schema.Boolean,
});
export type ComputerUseDiagnosticMetadata = typeof ComputerUseDiagnosticMetadata.Type;

export const ComputerUseTestResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  passed: Schema.Boolean,
  failureCategory: Schema.NullOr(ComputerUseTestFailureCategory),
  metadata: ComputerUseDiagnosticMetadata,
  remediation: Schema.Array(ComputerUseRemediation),
});
export type ComputerUseTestResult = typeof ComputerUseTestResult.Type;

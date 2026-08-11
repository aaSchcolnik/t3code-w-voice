import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyUsageScreenError,
  resolveUsageEnvironmentId,
  sortUsageEnvironments,
  type UsageEnvironmentOption,
} from "./usageScreen.logic";

const environment = (environmentId: string, label: string): UsageEnvironmentOption => ({
  environmentId: environmentId as EnvironmentId,
  label,
});

describe("usage environment selection", () => {
  const environments = [
    environment("charlie", "Zulu"),
    environment("bravo", "Bravo"),
    environment("alpha", "alpha"),
  ];

  it("sorts environments by label without case sensitivity", () => {
    expect(sortUsageEnvironments(environments)).toEqual([
      environment("alpha", "alpha"),
      environment("bravo", "Bravo"),
      environment("charlie", "Zulu"),
    ]);
  });

  it("defaults to the first sorted environment and preserves a valid selection", () => {
    const sorted = sortUsageEnvironments(environments);
    expect(resolveUsageEnvironmentId(sorted, null)).toBe("alpha");
    expect(resolveUsageEnvironmentId(sorted, "charlie" as EnvironmentId)).toBe("charlie");
  });

  it("falls back when the selected environment disappears", () => {
    const sorted = sortUsageEnvironments(environments);
    expect(resolveUsageEnvironmentId(sorted, "missing" as EnvironmentId)).toBe("alpha");
    expect(resolveUsageEnvironmentId([], "missing" as EnvironmentId)).toBeNull();
  });
});

describe("usage error classification", () => {
  it("recognizes the Effect RPC defect returned by an older server", () => {
    expect(classifyUsageScreenError("Unknown request tag: usage.read")).toBe("unsupported-server");
    expect(classifyUsageScreenError("RpcClientDefect: Unknown request tag: usage.read")).toBe(
      "unsupported-server",
    );
  });

  it("leaves unrelated RPC and connection failures alarming", () => {
    expect(classifyUsageScreenError("Unknown request tag: projects.list")).toBe("request-failed");
    expect(classifyUsageScreenError("The environment request failed.")).toBe("request-failed");
    expect(classifyUsageScreenError(null)).toBeNull();
  });
});

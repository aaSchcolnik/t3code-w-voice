// @effect-diagnostics globalDate:off -- Deterministic epoch fixtures exercise cache expiry.
import { describe, expect, it } from "@effect/vitest";

import type { SubscriptionUsageCard } from "@t3tools/contracts";

import { makeCachedUsageReader, type UsageProviderAdapter } from "./UsageService.ts";

function card(provider: "codex" | "claude", refreshedAt: string): SubscriptionUsageCard {
  return {
    key: provider,
    provider,
    displayName: provider === "codex" ? "Codex" : "Claude",
    sourceStability: provider === "codex" ? "official" : "vendor-private",
    status: "available",
    metrics: [],
    refreshedAt,
    stale: false,
  };
}

describe("cached subscription usage reader", () => {
  it("coalesces concurrent refreshes and reuses the five-minute snapshot", async () => {
    let now = 1_000;
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: UsageProviderAdapter = {
      provider: "codex",
      key: "codex",
      displayName: "Codex",
      sourceStability: "official",
      fallbackMessage: "unavailable",
      read: async () => {
        reads += 1;
        await gate;
        return card("codex", new Date(now).toISOString());
      },
    };
    const reader = makeCachedUsageReader({
      adapters: [adapter],
      now: () => now,
      refreshIntervalMs: 300_000,
    });

    const first = reader.read({});
    const second = reader.read({ force: true });
    release?.();
    expect(await first).toBe(await second);
    expect(reads).toBe(1);

    now += 1_000;
    await reader.read({ force: true });
    expect(reads).toBe(1);

    now += 298_999;
    await reader.read({});
    expect(reads).toBe(1);

    now += 1;
    await reader.read({ force: true });
    expect(reads).toBe(2);
  });

  it("keeps last-good provider data stale when another refresh fails", async () => {
    let now = 1_000;
    let failClaude = false;
    const adapters: UsageProviderAdapter[] = [
      {
        provider: "codex",
        key: "codex",
        displayName: "Codex",
        sourceStability: "official",
        fallbackMessage: "Codex failed.",
        read: async () => card("codex", new Date(now).toISOString()),
      },
      {
        provider: "claude",
        key: "claude",
        displayName: "Claude",
        sourceStability: "vendor-private",
        fallbackMessage: "Claude failed.",
        read: async () => {
          if (failClaude) throw new Error("credential=secret");
          return card("claude", new Date(now).toISOString());
        },
      },
    ];
    const reader = makeCachedUsageReader({ adapters, now: () => now, refreshIntervalMs: 10 });
    await reader.read({});

    failClaude = true;
    now += 11;
    const refreshed = await reader.read({});
    expect(refreshed.cards[0]).toMatchObject({ provider: "codex", stale: false });
    expect(refreshed.cards[1]).toMatchObject({
      provider: "claude",
      stale: true,
      message: "Claude failed.",
    });
    expect(JSON.stringify(refreshed)).not.toContain("credential=secret");
  });
});

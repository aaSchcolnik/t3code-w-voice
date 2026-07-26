import type { ModelCatalogEntry, ModelDownloadState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createStartFallbackTranscriber,
  resolveLocalLanguage,
  resolveVoiceMode,
  selectDownloadedModel,
} from "./transcriberFactory";
import type { DictationTranscriber } from "./types";

describe("transcriberFactory", () => {
  it("preserves the server path in auto when it is enabled", () => {
    expect(
      resolveVoiceMode({
        preference: "auto",
        serverEnabled: true,
        localPresent: true,
      }),
    ).toBe("server");
  });

  it("allows explicit local mode independently of the server enable flag", () => {
    expect(
      resolveVoiceMode({
        preference: "local",
        serverEnabled: false,
        localPresent: true,
      }),
    ).toBe("local");
  });

  it("falls back when a non-detecting model does not cover the locale", () => {
    expect(
      resolveLocalLanguage({
        configuredLanguage: "",
        locale: "ja-JP",
        capabilities: {
          languages: ["en", "es"],
          supportsLanguageDetect: false,
          supportsInitialPrompt: false,
          supportsStreaming: false,
        },
      }),
    ).toEqual({ language: "en", unsupported: "ja" });
  });

  it("honors the exact selected model and quantization before other downloads", () => {
    const catalog = [
      { id: "a", quantizations: [] },
      { id: "b", quantizations: [] },
    ] as unknown as ReadonlyArray<ModelCatalogEntry>;
    const states = [
      { modelId: "a", quantizationId: "Q4", status: "done" },
      { modelId: "b", quantizationId: "Q8", status: "done" },
    ] as unknown as ReadonlyArray<ModelDownloadState>;

    expect(selectDownloadedModel(catalog, states, "b", "Q8")).toEqual({
      model: catalog[1],
      download: states[1],
    });
  });

  it("retries a failed automatic server start with the downloaded local model", async () => {
    const calls: string[] = [];
    const transcriber = (name: string, failStart = false): DictationTranscriber => ({
      async start() {
        calls.push(`${name}:start`);
        if (failStart) throw new Error("unreachable");
      },
      pushAudio() {
        calls.push(`${name}:audio`);
      },
      async stopAndCommit() {
        calls.push(`${name}:stop`);
      },
      cancel() {
        calls.push(`${name}:cancel`);
      },
    });
    const onFallback = vi.fn();
    const fallback = createStartFallbackTranscriber({
      primary: transcriber("server", true),
      fallback: transcriber("local"),
      fallbackLanguage: "en",
      onFallback,
    });

    await fallback.start({ sessionId: "session" });
    fallback.pushAudio(new Float32Array([0.1]));
    await fallback.stopAndCommit();

    expect(calls).toEqual(["server:start", "local:start", "local:audio", "local:stop"]);
    expect(onFallback).toHaveBeenCalledOnce();
  });
});

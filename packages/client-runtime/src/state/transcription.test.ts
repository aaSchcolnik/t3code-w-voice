import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createTranscriptionAtoms } from "./transcription.ts";

describe("createTranscriptionAtoms", () => {
  it("keeps a session subscription stable and briefly retained", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const transcription = createTranscriptionAtoms(runtime);
    const target = {
      environmentId: EnvironmentId.make("environment-1"),
      input: { sessionId: "session-1" },
    };
    const updates = transcription.updates(target);

    expect(transcription.updates({ ...target, input: { ...target.input } })).toBe(updates);
    expect(updates.idleTTL).toBe(1_000);
  });

  it("exposes cached state and a retained progress subscription for server models", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const transcription = createTranscriptionAtoms(runtime);
    const target = {
      environmentId: EnvironmentId.make("environment-1"),
      input: {},
    };

    expect(transcription.modelState({ ...target })).toBe(transcription.modelState(target));
    expect(transcription.modelEvents({ ...target }).idleTTL).toBe(5_000);
  });
});

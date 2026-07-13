import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SkillRepository } from "../../persistence/Services/Skills.ts";
import { DEFAULT_SKILLS } from "./defaults.ts";

export const SkillDefaultsSeederLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const skills = yield* SkillRepository;
    yield* skills.seedDefaults(DEFAULT_SKILLS);
  }).pipe(Effect.withSpan("skills.seedDefaults")),
);

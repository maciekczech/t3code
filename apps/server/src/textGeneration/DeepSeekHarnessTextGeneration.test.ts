import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeDeepSeekHarnessTextGeneration } from "./DeepSeekHarnessTextGeneration.ts";

it.effect("fails auxiliary generation explicitly instead of leaking scratch sessions", () =>
  Effect.gen(function* () {
    const textGeneration = yield* makeDeepSeekHarnessTextGeneration;
    const error = yield* Effect.flip(
      textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Implement the provider",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseekHarness"),
          model: "deepseek-official/deepseek-v4-pro",
        },
      }),
    );

    assert.strictEqual(error._tag, "TextGenerationError");
    assert.match(error.detail, /not enabled/i);
  }),
);

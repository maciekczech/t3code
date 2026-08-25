import { assert, it } from "@effect/vitest";
import { DeepSeekHarnessSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DeepSeekHarnessRuntime,
  isSupportedDeepSeekHarnessNodeVersion,
  type DeepSeekHarnessRuntimeShape,
} from "../deepseekHarnessRuntime.ts";
import { DeepSeekHostClient } from "../deepseekHarness/DeepSeekHostClient.ts";
import { checkDeepSeekHarnessProviderStatus } from "./DeepSeekHarnessProvider.ts";

const decodeSettings = Schema.decodeSync(DeepSeekHarnessSettings);

class CatalogClient extends DeepSeekHostClient {
  constructor() {
    super({ baseUrl: "http://127.0.0.1:3080" });
  }

  override async modelCatalog() {
    return {
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              reasoning: {
                efforts: [
                  { id: "low", name: "Low" },
                  { id: "high", name: "High" },
                ],
                defaultEffort: "high",
              },
            },
          ],
        },
      ],
      failures: [],
    };
  }
}

function runtime(version: string): DeepSeekHarnessRuntimeShape {
  return {
    runCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    readVersion: () => Effect.succeed(version),
    startHost: () =>
      Effect.succeed({
        url: "http://127.0.0.1:3080",
        client: new CatalogClient(),
        exitCode: Effect.never,
      }),
  };
}

it.effect("keeps the developer preview disabled by default", () =>
  Effect.gen(function* () {
    const provider = yield* checkDeepSeekHarnessProviderStatus(decodeSettings({}));
    assert.strictEqual(provider.enabled, false);
    assert.strictEqual(provider.status, "disabled");
    assert.match(provider.message ?? "", /disabled/i);
  }).pipe(Effect.provideService(DeepSeekHarnessRuntime, runtime("0.1.1-rc.2"))),
);

it.effect("rejects an unverified host version before startup", () =>
  Effect.gen(function* () {
    const provider = yield* checkDeepSeekHarnessProviderStatus(decodeSettings({ enabled: true }));
    assert.strictEqual(provider.status, "error");
    assert.strictEqual(provider.version, "0.1.1-rc.3");
    assert.match(provider.message ?? "", /unverified/i);
  }).pipe(Effect.provideService(DeepSeekHarnessRuntime, runtime("0.1.1-rc.3"))),
);

it.effect("publishes discovered models and reasoning effort options", () =>
  Effect.gen(function* () {
    const provider = yield* checkDeepSeekHarnessProviderStatus(decodeSettings({ enabled: true }));
    assert.strictEqual(provider.status, "ready");
    assert.strictEqual(provider.auth.status, "unknown");
    assert.deepStrictEqual(
      provider.models.map((model) => model.slug),
      ["deepseek-official/deepseek-chat"],
    );
    assert.deepStrictEqual(provider.models[0]?.capabilities?.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  }).pipe(Effect.provideService(DeepSeekHarnessRuntime, runtime("0.1.1-rc.2"))),
);

it("matches the upstream Node support range", () => {
  assert.isFalse(isSupportedDeepSeekHarnessNodeVersion("22.18.0"));
  assert.isTrue(isSupportedDeepSeekHarnessNodeVersion("22.19.0"));
  assert.isFalse(isSupportedDeepSeekHarnessNodeVersion("23.11.0"));
  assert.isTrue(isSupportedDeepSeekHarnessNodeVersion("24.0.0"));
});

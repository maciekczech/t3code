import type {
  DeepSeekHarnessSettings,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  DeepSeekHarnessRuntime,
  DeepSeekHarnessRuntimeError,
  DEEPSEEK_HARNESS_NODE_RANGE,
  deepSeekHarnessRuntimeErrorDetail,
  isSupportedDeepSeekHarnessNodeVersion,
  SUPPORTED_DEEPSEEK_HARNESS_VERSIONS,
} from "../deepseekHarnessRuntime.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "DeepSeek Harness",
  badgeLabel: "Developer Preview",
  showInteractionModeToggle: true,
} as const;

const DEFAULT_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function flattenModels(
  groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly models: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly reasoning?: {
        readonly efforts: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly description?: string;
        }>;
        readonly defaultEffort?: string;
      };
    }>;
  }>,
): ReadonlyArray<ServerProviderModel> {
  return groups
    .flatMap((group) =>
      group.models.map((model) => {
        const reasoning = model.reasoning;
        const capabilities = createModelCapabilities({
          optionDescriptors:
            reasoning === undefined
              ? []
              : [
                  buildSelectOptionDescriptor({
                    id: "reasoningEffort",
                    label: "Reasoning effort",
                    options: reasoning.efforts.map((effort) => ({
                      value: effort.id,
                      label: effort.name,
                      ...(effort.description === undefined
                        ? {}
                        : { description: effort.description }),
                      ...(effort.id === reasoning.defaultEffort ? { isDefault: true } : {}),
                    })),
                  }),
                ],
        });
        return {
          slug: `${group.id}/${model.id}`,
          name: model.name,
          subProvider: group.name,
          isCustom: false,
          capabilities,
        } satisfies ServerProviderModel;
      }),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingDeepSeekHarnessProvider = (
  settings: DeepSeekHarnessSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "DeepSeek Harness status has not been checked yet."
          : "DeepSeek Harness is disabled. Enable this developer preview to test it.",
      },
    });
  });

export const checkDeepSeekHarnessProviderStatus = Effect.fn("checkDeepSeekHarnessProviderStatus")(
  function* (
    settings: DeepSeekHarnessSettings,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<ServerProviderDraft, never, DeepSeekHarnessRuntime> {
    const runtime = yield* DeepSeekHarnessRuntime;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) return yield* makePendingDeepSeekHarnessProvider(settings);

    const versionExit = yield* Effect.exit(
      runtime.readVersion({
        binaryPath: settings.binaryPath,
        ...(environment === undefined ? {} : { environment }),
      }),
    );
    if (versionExit._tag === "Failure") {
      const detail = deepSeekHarnessRuntimeErrorDetail(Cause.squash(versionExit.cause));
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
        probe: {
          installed: !detail.toLowerCase().includes("enoent"),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: detail.toLowerCase().includes("enoent")
            ? "DeepSeek Harness (`dsh`) is not installed or not on PATH."
            : `Could not inspect DeepSeek Harness: ${detail}`,
        },
      });
    }

    const version = versionExit.value;
    if (!isSupportedDeepSeekHarnessNodeVersion(process.versions.node)) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `DeepSeek Harness requires Node ${DEEPSEEK_HARNESS_NODE_RANGE}; T3 Code is running Node ${process.versions.node}.`,
        },
      });
    }
    if (!(SUPPORTED_DEEPSEEK_HARNESS_VERSIONS as ReadonlyArray<string>).includes(version)) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `DeepSeek Harness ${version} is unverified. Install ${SUPPORTED_DEEPSEEK_HARNESS_VERSIONS.join(" or ")}.`,
        },
      });
    }

    const catalogExit = yield* Effect.exit(
      runtime
        .startHost({
          binaryPath: settings.binaryPath,
          ...(environment === undefined ? {} : { environment }),
          ...(settings.launchArgs ? { launchArgs: settings.launchArgs } : {}),
        })
        .pipe(
          Effect.flatMap((host) =>
            Effect.tryPromise({
              try: () => host.client.modelCatalog(),
              catch: (cause) =>
                new DeepSeekHarnessRuntimeError({
                  operation: "llm.models",
                  detail: deepSeekHarnessRuntimeErrorDetail(cause),
                  cause,
                }),
            }),
          ),
          Effect.scoped,
        ),
    );
    if (catalogExit._tag === "Failure") {
      const detail = deepSeekHarnessRuntimeErrorDetail(Cause.squash(catalogExit.cause));
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `DeepSeek Harness host probe failed: ${detail}`,
        },
      });
    }

    const models = providerModelsFromSettings(
      flattenModels(catalogExit.value.groups),
      settings.customModels,
      DEFAULT_CAPABILITIES,
    );
    const failures = catalogExit.value.failures
      .map((failure: { readonly message: string }) => failure.message)
      .filter(Boolean);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: "unknown" },
        ...(models.length > 0
          ? failures.length > 0
            ? { message: `Some DeepSeek model providers failed: ${failures.join("; ")}` }
            : {}
          : { message: failures[0] ?? "DeepSeek Harness reported no available models." }),
      },
    });
  },
);

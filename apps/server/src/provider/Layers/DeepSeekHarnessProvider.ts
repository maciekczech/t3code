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
const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

function errorSnapshot(input: {
  readonly settings: DeepSeekHarnessSettings;
  readonly checkedAt: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly message: string;
}) {
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings([], input.settings.customModels, DEFAULT_CAPABILITIES),
    probe: {
      installed: input.installed,
      version: input.version,
      status: "error",
      auth: { status: "unknown" },
      message: input.message,
    },
  });
}

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

export const makePendingDeepSeekHarnessProvider = Effect.fn("makePendingDeepSeekHarnessProvider")(
  function* (settings: DeepSeekHarnessSettings): Effect.fn.Return<ServerProviderDraft> {
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
  },
);

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
      return errorSnapshot({
        settings,
        checkedAt,
        installed: !detail.toLowerCase().includes("enoent"),
        version: null,
        message: detail.toLowerCase().includes("enoent")
          ? "DeepSeek Harness (`dsh`) is not installed or not on PATH."
          : `Could not inspect DeepSeek Harness: ${detail}`,
      });
    }

    const version = versionExit.value;
    if (!isSupportedDeepSeekHarnessNodeVersion(process.versions.node)) {
      return errorSnapshot({
        settings,
        checkedAt,
        installed: true,
        version,
        message: `DeepSeek Harness requires Node ${DEEPSEEK_HARNESS_NODE_RANGE}; T3 Code is running Node ${process.versions.node}.`,
      });
    }
    if (!(SUPPORTED_DEEPSEEK_HARNESS_VERSIONS as ReadonlyArray<string>).includes(version)) {
      return errorSnapshot({
        settings,
        checkedAt,
        installed: true,
        version,
        message: `DeepSeek Harness ${version} is unverified. Install ${SUPPORTED_DEEPSEEK_HARNESS_VERSIONS.join(" or ")}.`,
      });
    }

    const probeExit = yield* Effect.exit(
      runtime
        .startHost({
          binaryPath: settings.binaryPath,
          ...(environment === undefined ? {} : { environment }),
          ...(settings.launchArgs ? { launchArgs: settings.launchArgs } : {}),
        })
        .pipe(
          Effect.flatMap((host) =>
            Effect.tryPromise({
              try: async () => {
                const [catalog, credentials] = await Promise.all([
                  host.client.modelCatalog(),
                  host.client.describeCredentials([DEEPSEEK_API_KEY_REF]),
                ]);
                return { catalog, credentials };
              },
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
    if (probeExit._tag === "Failure") {
      const detail = deepSeekHarnessRuntimeErrorDetail(Cause.squash(probeExit.cause));
      return errorSnapshot({
        settings,
        checkedAt,
        installed: true,
        version,
        message: `DeepSeek Harness host probe failed: ${detail}`,
      });
    }

    const models = providerModelsFromSettings(
      flattenModels(probeExit.value.catalog.groups),
      settings.customModels,
      DEFAULT_CAPABILITIES,
    );
    const failures = probeExit.value.catalog.failures
      .map((failure: { readonly message: string }) => failure.message)
      .filter(Boolean);
    const credential = probeExit.value.credentials[DEEPSEEK_API_KEY_REF];
    const configured = credential?.configured === true;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: !configured ? "error" : models.length > 0 ? "ready" : "warning",
        auth: configured
          ? { status: "authenticated", type: "api-key", label: "API key configured" }
          : { status: "unauthenticated", type: "api-key", label: "DEEPSEEK_API_KEY required" },
        ...(!configured
          ? {
              message:
                "Add DEEPSEEK_API_KEY to this provider's environment variables. Its validity is confirmed on the first prompt.",
            }
          : models.length > 0
            ? failures.length > 0
              ? { message: `Some DeepSeek model providers failed: ${failures.join("; ")}` }
              : {}
            : { message: failures[0] ?? "DeepSeek Harness reported no available models." }),
      },
    });
  },
);

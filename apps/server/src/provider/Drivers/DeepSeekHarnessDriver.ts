import {
  DeepSeekHarnessSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDeepSeekHarnessTextGeneration } from "../../textGeneration/DeepSeekHarnessTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekHarnessAdapter } from "../Layers/DeepSeekHarnessAdapter.ts";
import {
  checkDeepSeekHarnessProviderStatus,
  makePendingDeepSeekHarnessProvider,
} from "../Layers/DeepSeekHarnessProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { DeepSeekHarnessRuntime } from "../deepseekHarnessRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeSettings = Schema.decodeSync(DeepSeekHarnessSettings);
const DRIVER_KIND = ProviderDriverKind.make("deepseekHarness");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@deepseek-ai/dsh",
});

export type DeepSeekHarnessDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | DeepSeekHarnessRuntime
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

const stampIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
    continuation: { groupKey: input.continuationKey },
  });

export const DeepSeekHarnessDriver: ProviderDriver<
  DeepSeekHarnessSettings,
  DeepSeekHarnessDriverEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true },
  configSchema: DeepSeekHarnessSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const runtime = yield* DeepSeekHarnessRuntime;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = stampIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies DeepSeekHarnessSettings;
      const configuredHome = effectiveConfig.homePath.trim();
      const homePath = path.resolve(
        configuredHome
          ? expandHomePath(configuredHome)
          : path.join(serverConfig.stateDir, "providers", "deepseekHarness", instanceId),
      );
      yield* fileSystem.makeDirectory(homePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Could not create DeepSeek Harness home '${homePath}'.`,
              cause,
            }),
        ),
      );
      const processEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        DSH_HOME: homePath,
      } satisfies NodeJS.ProcessEnv;
      const adapter = yield* makeDeepSeekHarnessAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const textGeneration = yield* makeDeepSeekHarnessTextGeneration;
      const checkProvider = checkDeepSeekHarnessProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stamp),
        Effect.provideService(DeepSeekHarnessRuntime, runtime),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DeepSeekHarnessSettings>
      >({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingDeepSeekHarnessProvider(settings.provider).pipe(Effect.map(stamp)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, MAINTENANCE, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build DeepSeek Harness snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

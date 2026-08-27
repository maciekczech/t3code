import { parseCliArgs, tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import { DeepSeekHostClient } from "./deepseekHarness/DeepSeekHostClient.ts";

export const SUPPORTED_DEEPSEEK_HARNESS_VERSIONS = ["0.1.1-rc.2"] as const;
export const DEEPSEEK_HARNESS_NODE_RANGE = "^22.19.0 || >=24.0.0";
const READY_PREFIX = "dsh web:";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 32 * 1024;
const RESERVED_LAUNCH_FLAGS = new Set(["host", "port", "open", "no-open"]);

export function isSupportedDeepSeekHarnessNodeVersion(version: string): boolean {
  return satisfiesSemverRange(version, DEEPSEEK_HARNESS_NODE_RANGE);
}

export class DeepSeekHarnessRuntimeError extends Schema.TaggedErrorClass<DeepSeekHarnessRuntimeError>()(
  "DeepSeekHarnessRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

const isDeepSeekHarnessRuntimeError = Schema.is(DeepSeekHarnessRuntimeError);

export interface DeepSeekHarnessCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface DeepSeekHarnessHostProcess {
  readonly url: string;
  readonly client: DeepSeekHostClient;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface DeepSeekHarnessRuntimeShape {
  readonly runCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }) => Effect.Effect<DeepSeekHarnessCommandResult, DeepSeekHarnessRuntimeError>;
  readonly readVersion: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<string, DeepSeekHarnessRuntimeError>;
  readonly startHost: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly launchArgs?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<DeepSeekHarnessHostProcess, DeepSeekHarnessRuntimeError, Scope.Scope>;
}

export function deepSeekHarnessRuntimeErrorDetail(cause: unknown): string {
  if (isDeepSeekHarnessRuntimeError(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  return String(cause);
}

export function parseDeepSeekHarnessVersion(output: string): string | null {
  const match = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1] ?? null;
}

export function parseDeepSeekHarnessReadyUrl(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(READY_PREFIX)) continue;
    const candidate = trimmed.slice(READY_PREFIX.length).trim();
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveDeepSeekHarnessLaunchArgs(input: string | undefined): ReadonlyArray<string> {
  const tokens = tokenizeCliArgs(input);
  const parsed = parseCliArgs(tokens, { booleanFlags: ["open", "no-open"] });
  const reserved = Object.keys(parsed.flags).find((flag) => RESERVED_LAUNCH_FLAGS.has(flag));
  if (reserved !== undefined) {
    throw new DeepSeekHarnessRuntimeError({
      operation: "resolveLaunchArgs",
      detail: `launchArgs cannot override T3-owned --${reserved}`,
    });
  }
  return tokens;
}

function ensureRuntimeError(operation: string, detail: string, cause: unknown) {
  return isDeepSeekHarnessRuntimeError(cause)
    ? cause
    : new DeepSeekHarnessRuntimeError({ operation, detail, cause });
}

const makeDeepSeekHarnessRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;

  const runCommand: DeepSeekHarnessRuntimeShape["runCommand"] = Effect.fn(
    "DeepSeekHarnessRuntime.runCommand",
  )(
    function* (input) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath,
        input.args,
        input.environment === undefined ? {} : { env: input.environment },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.environment === undefined
            ? { extendEnv: true }
            : { env: input.environment, extendEnv: false }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, { maxBytes: MAX_DIAGNOSTIC_OUTPUT_BYTES }),
          collectStreamAsString(child.stderr, { maxBytes: MAX_DIAGNOSTIC_OUTPUT_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new DeepSeekHarnessRuntimeError({
          operation: "runCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return { stdout, stderr, code: exitCode };
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      ensureRuntimeError(
        "runCommand",
        `Failed to execute DeepSeek Harness command: ${deepSeekHarnessRuntimeErrorDetail(cause)}`,
        cause,
      ),
    ),
  );

  const readVersion: DeepSeekHarnessRuntimeShape["readVersion"] = Effect.fn(
    "DeepSeekHarnessRuntime.readVersion",
  )(function* (input) {
    const result = yield* runCommand({
      binaryPath: input.binaryPath,
      args: ["--version"],
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });
    if (result.code !== 0) {
      return yield* new DeepSeekHarnessRuntimeError({
        operation: "readVersion",
        detail: `dsh --version exited with code ${result.code}: ${result.stderr.trim()}`,
      });
    }
    const version = parseDeepSeekHarnessVersion(`${result.stdout}\n${result.stderr}`);
    if (version === null) {
      return yield* new DeepSeekHarnessRuntimeError({
        operation: "readVersion",
        detail: "Could not parse the DeepSeek Harness version.",
      });
    }
    return version;
  });

  const startHost: DeepSeekHarnessRuntimeShape["startHost"] = Effect.fn(
    "DeepSeekHarnessRuntime.startHost",
  )(function* (input) {
    const runtimeScope = yield* Scope.Scope;
    if (!isSupportedDeepSeekHarnessNodeVersion(process.versions.node)) {
      return yield* new DeepSeekHarnessRuntimeError({
        operation: "startHost",
        detail: `DeepSeek Harness requires Node ${DEEPSEEK_HARNESS_NODE_RANGE}; T3 Code is running Node ${process.versions.node}.`,
      });
    }
    const version = yield* readVersion(input);
    if (!(SUPPORTED_DEEPSEEK_HARNESS_VERSIONS as ReadonlyArray<string>).includes(version)) {
      return yield* new DeepSeekHarnessRuntimeError({
        operation: "startHost",
        detail: `Unsupported DeepSeek Harness ${version}; install ${SUPPORTED_DEEPSEEK_HARNESS_VERSIONS.join(" or ")}.`,
      });
    }

    const extraArgs = yield* Effect.try({
      try: () => resolveDeepSeekHarnessLaunchArgs(input.launchArgs),
      catch: (cause) =>
        ensureRuntimeError(
          "startHost",
          `Invalid DeepSeek Harness launch arguments: ${deepSeekHarnessRuntimeErrorDetail(cause)}`,
          cause,
        ),
    });
    const args = ["web", "--host", "127.0.0.1", "--port", "0", "--no-open", ...extraArgs];
    const spawnCommand = yield* resolveSpawnCommand(
      input.binaryPath,
      args,
      input.environment === undefined ? {} : { env: input.environment },
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.environment === undefined
            ? { extendEnv: true }
            : { env: input.environment, extendEnv: false }),
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "startHost",
            `Failed to spawn DeepSeek Harness: ${deepSeekHarnessRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      );

    const killGroup = (signal: NodeJS.Signals) =>
      hostPlatform === "win32"
        ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
        : Effect.sync(() => {
            try {
              process.kill(-Number(child.pid), signal);
            } catch {
              // The scoped child may already have exited.
            }
          });
    yield* Scope.addFinalizer(
      runtimeScope,
      killGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killGroup("SIGKILL")),
        Effect.ignore,
      ),
    );

    const stdoutRef = yield* Ref.make("");
    const stderrRef = yield* Ref.make("");
    const ready = yield* Deferred.make<string, DeepSeekHarnessRuntimeError>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.updateAndGet(stdoutRef, (current) => `${current}${chunk}`).pipe(
          Effect.flatMap((current) => {
            const url = parseDeepSeekHarnessReadyUrl(current);
            return url === null ? Effect.void : Deferred.succeed(ready, url).pipe(Effect.ignore);
          }),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderrRef, (current) =>
          `${current}${chunk}`.slice(-MAX_DIAGNOSTIC_OUTPUT_BYTES),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );
    yield* child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          const stderr = yield* Ref.get(stderrRef);
          yield* Deferred.fail(
            ready,
            new DeepSeekHarnessRuntimeError({
              operation: "startHost",
              detail: `DeepSeek Harness exited before readiness (code ${Number(code)}).${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
            }),
          ).pipe(Effect.ignore);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );

    const readyExit = yield* Effect.exit(
      Deferred.await(ready).pipe(
        Effect.timeoutOption(input.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(readyExit)) {
      const cause = Cause.squash(readyExit.cause);
      return yield* ensureRuntimeError(
        "startHost",
        `Failed while waiting for DeepSeek Harness: ${deepSeekHarnessRuntimeErrorDetail(cause)}`,
        cause,
      );
    }
    if (Option.isNone(readyExit.value)) {
      return yield* new DeepSeekHarnessRuntimeError({
        operation: "startHost",
        detail: `Timed out waiting for DeepSeek Harness after ${input.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS}ms.`,
      });
    }
    const url = readyExit.value.value;
    const client = new DeepSeekHostClient({ baseUrl: url });
    yield* Effect.tryPromise({
      try: () => client.listSessions(),
      catch: (cause) =>
        new DeepSeekHarnessRuntimeError({
          operation: "startHost",
          detail: `DeepSeek Harness boot probe failed: ${deepSeekHarnessRuntimeErrorDetail(cause)}`,
          cause,
        }),
    });
    return {
      url,
      client,
      exitCode: child.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => 0),
      ),
    };
  });

  return { runCommand, readVersion, startHost } satisfies DeepSeekHarnessRuntimeShape;
});

export class DeepSeekHarnessRuntime extends Context.Service<
  DeepSeekHarnessRuntime,
  DeepSeekHarnessRuntimeShape
>()("t3/provider/deepseekHarnessRuntime") {}

export const DeepSeekHarnessRuntimeLive = Layer.effect(
  DeepSeekHarnessRuntime,
  makeDeepSeekHarnessRuntime,
);

/**
 * DeepSeekHarnessAdapterLive — DeepSeek Harness via its loopback Web Host API.
 *
 * @module DeepSeekHarnessAdapterLive
 */

import {
  ApprovalRequestId,
  EventId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  DeepSeekHarnessRuntime,
  deepSeekHarnessRuntimeErrorDetail,
  type DeepSeekHarnessHostProcess,
} from "../deepseekHarnessRuntime.ts";
import type {
  DeepSeekQuestion,
  DeepSeekMuxFrame,
  DeepSeekSessionEvent,
} from "../deepseekHarness/DeepSeekHostProtocol.ts";
import {
  DeepSeekEventTranslator,
  type DeepSeekTranslatedEvent,
} from "../deepseekHarness/DeepSeekEventTranslator.ts";
import { classifyDeepSeekTool } from "../deepseekHarness/DeepSeekToolClassification.ts";
import type { DeepSeekHarnessAdapterShape } from "../Services/DeepSeekHarnessAdapter.ts";

const PROVIDER = ProviderDriverKind.make("deepseekHarness");
const RESUME_VERSION = 1 as const;
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(RESUME_VERSION),
  sessionId: Schema.String,
});
const isResumeCursor = Schema.is(ResumeCursor);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface DeepSeekHarnessAdapterSettings {
  readonly binaryPath: string;
  readonly launchArgs?: string;
}

export interface DeepSeekHarnessAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

interface PendingApproval {
  readonly rpcId: string;
  readonly approvalId: string;
  readonly requestType: "command_execution_approval" | "file_change_approval" | "dynamic_tool_call";
}

interface PendingQuestion {
  readonly rpcId: string;
  readonly questions: ReadonlyArray<DeepSeekQuestion>;
  answers?: ProviderUserInputAnswers;
}

type DeepSeekPermissionPreset = "read-only" | "workspace-write" | "danger-full-access";

interface TurnBoundary {
  readonly turnId: TurnId;
  readonly completed: Deferred.Deferred<void>;
}

interface SessionContext {
  session: ProviderSession;
  readonly providerSessionId: string;
  readonly translator: DeepSeekEventTranslator;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingQuestions: Map<ApprovalRequestId, PendingQuestion>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  lastSeq: number;
  activeTurnId: TurnId | undefined;
  interactionMode: "unknown" | "default" | "plan";
  permissionPreset: DeepSeekPermissionPreset | undefined;
  turnBoundary: TurnBoundary | undefined;
}

interface SharedHost {
  readonly scope: Scope.Closeable;
  readonly process: DeepSeekHarnessHostProcess;
  failed: boolean;
  stopping: boolean;
}

function runtimePreset(mode: RuntimeMode): DeepSeekPermissionPreset {
  switch (mode) {
    case "approval-required":
      return "read-only";
    case "auto-accept-edits":
    case "auto":
      return "workspace-write";
    case "full-access":
      return "danger-full-access";
  }
}

function deepSeekUserMessage(rawDetail: string): string {
  const normalized = rawDetail.toLowerCase();
  if (normalized.includes("no api key") || normalized.includes("missing_credential")) {
    return "DeepSeek API key is missing. Add DEEPSEEK_API_KEY to this provider's environment variables.";
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("invalid api key") ||
    normalized.includes("authentication failed") ||
    normalized.includes("http 401")
  ) {
    return "DeepSeek rejected DEEPSEEK_API_KEY. Replace it in this provider's environment variables and try again.";
  }
  return rawDetail;
}

function asAdapterError(method: string, cause: unknown): ProviderAdapterRequestError {
  const detail = deepSeekUserMessage(deepSeekHarnessRuntimeErrorDetail(cause));
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    cause,
  });
}

function requestTypeForTool(
  toolName: string,
): "command_execution_approval" | "file_change_approval" | "dynamic_tool_call" {
  const kind = classifyDeepSeekTool(toolName);
  if (kind === "command") return "command_execution_approval";
  if (kind === "fileChange") return "file_change_approval";
  return "dynamic_tool_call";
}

function normalizeQuestions(
  questions: ReadonlyArray<DeepSeekQuestion>,
): ReadonlyArray<UserInputQuestion> {
  return questions.map((question) => ({
    id: question.id || "question",
    header: question.header?.trim() || "Question",
    question: question.question.trim() || "Please choose an answer.",
    options: (question.options ?? []).map((option) => ({
      label: option.label.trim() || "Option",
      description: option.description?.trim() || option.label.trim() || "Option",
    })),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  }));
}

function questionAnswers(
  questions: ReadonlyArray<DeepSeekQuestion>,
  answers: Readonly<Record<string, unknown>>,
) {
  return questions.map((question) => {
    const raw =
      answers[question.id] ?? answers[question.header ?? ""] ?? answers[question.question];
    const values = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === "string")
      : typeof raw === "string" && raw.trim()
        ? [raw]
        : [];
    const optionLabels = new Set((question.options ?? []).map((option) => option.label));
    const selected = values.filter((value) => optionLabels.has(value));
    const custom = values.find((value) => !optionLabels.has(value))?.trim();
    return { id: question.id, selected, ...(custom ? { custom } : {}) };
  });
}

function isoFromMs(ms: number): string | undefined {
  const date = DateTime.make(ms);
  return date._tag === "Some" ? DateTime.formatIso(date.value) : undefined;
}

const DEEPSEEK_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const);

type DeepSeekImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
type DeepSeekImageContent = {
  readonly type: "image";
  readonly mediaType: DeepSeekImageMediaType;
  readonly data: string;
  readonly name?: string;
};

function nativeTurnNumber(event: DeepSeekSessionEvent): number | undefined {
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const turn = (data as Readonly<Record<string, unknown>>).turn;
  return typeof turn === "number" && Number.isInteger(turn) ? turn : undefined;
}

function historicalTurns(
  providerSessionId: string,
  events: ReadonlyArray<DeepSeekSessionEvent>,
): Array<{ readonly id: TurnId; readonly items: Array<unknown> }> {
  const byTurn = new Map<number, Array<unknown>>();
  for (const event of events.toSorted((left, right) => left.seq - right.seq)) {
    const turn = nativeTurnNumber(event);
    if (turn === undefined) continue;
    const items = byTurn.get(turn) ?? [];
    items.push(event);
    byTurn.set(turn, items);
  }
  return [...byTurn].map(([turn, items]) => ({
    id: TurnId.make(`deepseek-${providerSessionId}-${turn}`),
    items,
  }));
}

export function isSameDeepSeekDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) return Effect.succeed(true);
  const canonicalize = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

export function makeDeepSeekHarnessAdapter(
  settings: DeepSeekHarnessAdapterSettings,
  options?: DeepSeekHarnessAdapterOptions,
) {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("deepseekHarness");
    const serverConfig = yield* ServerConfig;
    const runtime = yield* DeepSeekHarnessRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();
    const threadsByProviderSession = new Map<string, ThreadId>();
    let sharedHost: SharedHost | undefined;

    const makeId = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => asAdapterError("crypto.randomUUIDv4", cause)),
    );
    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const buildBase = Effect.fn("DeepSeekHarnessAdapter.buildBase")(function* (input: {
      readonly threadId: ThreadId;
      readonly createdAtMs?: number;
      readonly turnId?: TurnId;
      readonly itemId?: string;
      readonly requestId?: string;
    }) {
      const eventId = EventId.make(yield* makeId);
      const createdAt =
        input.createdAtMs === undefined
          ? yield* nowIso
          : (isoFromMs(input.createdAtMs) ?? (yield* nowIso));
      return {
        eventId,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        createdAt,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        ...(input.itemId === undefined ? {} : { itemId: RuntimeItemId.make(input.itemId) }),
        ...(input.requestId === undefined
          ? {}
          : { requestId: RuntimeRequestId.make(input.requestId) }),
      };
    });

    const emitHostFailure = Effect.fn("DeepSeekHarnessAdapter.emitHostFailure")(function* (
      cause: unknown,
      errorClass: "provider_error" | "transport_error" = "transport_error",
    ) {
      const message = deepSeekUserMessage(deepSeekHarnessRuntimeErrorDetail(cause));
      yield* Effect.forEach(
        sessions.values(),
        (context) =>
          Effect.gen(function* () {
            const activeTurnId = context.activeTurnId;
            for (const requestId of context.pendingApprovals.keys()) {
              yield* emit({
                ...(yield* buildBase({ threadId: context.session.threadId, requestId })),
                type: "request.resolved",
                payload: { requestType: "unknown", decision: "unavailable" },
              });
            }
            context.pendingApprovals.clear();
            for (const requestId of context.pendingQuestions.keys()) {
              yield* emit({
                ...(yield* buildBase({ threadId: context.session.threadId, requestId })),
                type: "user-input.resolved",
                payload: { answers: {} },
              });
            }
            context.pendingQuestions.clear();
            yield* emit({
              ...(yield* buildBase({
                threadId: context.session.threadId,
                ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
              })),
              type: "runtime.error",
              payload: { message, class: errorClass },
            });
            if (activeTurnId !== undefined) {
              if (context.turnBoundary?.turnId === activeTurnId) {
                yield* Deferred.succeed(context.turnBoundary.completed, undefined).pipe(
                  Effect.ignore,
                );
                context.turnBoundary = undefined;
              }
              yield* emit({
                ...(yield* buildBase({
                  threadId: context.session.threadId,
                  turnId: activeTurnId,
                })),
                type: "turn.completed",
                payload: { state: "failed", stopReason: "host-failure", errorMessage: message },
              });
              context.translator.clearPendingTurnId(activeTurnId);
              context.activeTurnId = undefined;
            }
            const { activeTurnId: _activeTurnId, ...session } = context.session;
            const updatedAt = yield* nowIso;
            context.session = { ...session, status: "error", lastError: message, updatedAt };
            yield* emit({
              ...(yield* buildBase({ threadId: context.session.threadId })),
              type: "session.state.changed",
              payload: { state: "error", reason: "DeepSeek Harness host failed", detail: message },
            });
          }),
        { discard: true },
      );
    });

    const emitTranslated = Effect.fn("DeepSeekHarnessAdapter.emitTranslated")(function* (
      context: SessionContext,
      translated: DeepSeekTranslatedEvent,
    ) {
      yield* emit({
        ...(yield* buildBase({
          threadId: context.session.threadId,
          createdAtMs: translated.createdAtMs,
          ...(translated.turnId === undefined ? {} : { turnId: translated.turnId }),
          ...(translated.itemId === undefined ? {} : { itemId: translated.itemId }),
          ...(translated.requestId === undefined ? {} : { requestId: translated.requestId }),
        })),
        type: translated.type,
        payload: translated.payload,
        raw: {
          source: "deepseek.web-host.event",
          method: translated.raw.type,
          payload: translated.raw,
        },
      } as ProviderRuntimeEvent);
      if (translated.type === "turn.completed" && translated.turnId === context.activeTurnId) {
        const boundary = context.turnBoundary;
        if (boundary !== undefined && boundary.turnId === translated.turnId) {
          yield* Deferred.succeed(boundary.completed, undefined).pipe(Effect.ignore);
          context.turnBoundary = undefined;
        }
        context.activeTurnId = undefined;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, lastError: _lastError, ...session } = context.session;
        context.session = { ...session, status: "ready", updatedAt };
      }
    });

    const handleMuxFrame = Effect.fn("DeepSeekHarnessAdapter.handleMuxFrame")(function* (input: {
      readonly rpcId: string;
      readonly payload: DeepSeekMuxFrame;
    }) {
      if (input.payload.type === "stream/error") {
        return yield* asAdapterError("events.mux", input.payload.error.message);
      }
      const threadId =
        "sessionId" in input.payload
          ? threadsByProviderSession.get(input.payload.sessionId)
          : undefined;
      if (threadId === undefined) return;
      const context = sessions.get(threadId);
      if (context === undefined) return;
      const frame = input.payload;
      switch (frame.type) {
        case "session/event": {
          if (frame.event.seq <= context.lastSeq) return;
          context.lastSeq = frame.event.seq;
          const translatedEvents = yield* Effect.try({
            try: () => context.translator.translate(frame.event),
            catch: (cause) => asAdapterError(`translate ${frame.event.type}`, cause),
          });
          const turnId = translatedEvents.find((event) => event.turnId !== undefined)?.turnId;
          const turn =
            turnId === undefined ? undefined : context.turns.find((entry) => entry.id === turnId);
          turn?.items.push(frame.event);
          for (const translated of translatedEvents) {
            yield* emitTranslated(context, translated);
          }
          break;
        }
        case "approval/requested": {
          const requestId = ApprovalRequestId.make(frame.approvalId);
          const requestType = requestTypeForTool(frame.toolName);
          context.pendingApprovals.set(requestId, {
            rpcId: input.rpcId,
            approvalId: frame.approvalId,
            requestType,
          });
          yield* emit({
            ...(yield* buildBase({ threadId, requestId })),
            type: "request.opened",
            payload: {
              requestType,
              detail: frame.reason?.trim() || `DeepSeek Harness wants to run ${frame.toolName}.`,
              options: [
                { decision: "accept", label: "Allow once" },
                { decision: "decline", label: "Reject" },
              ],
              args: { toolName: frame.toolName, callId: frame.callId },
            },
          });
          break;
        }
        case "approval/resolved": {
          const requestId = ApprovalRequestId.make(frame.approvalId);
          const pending = context.pendingApprovals.get(requestId);
          if (pending === undefined) {
            yield* emit({
              ...(yield* buildBase({ threadId })),
              type: "runtime.error",
              payload: {
                message: `DeepSeek Harness resolved unknown approval '${frame.approvalId}'.`,
                class: "provider_error",
              },
            });
            break;
          }
          context.pendingApprovals.delete(requestId);
          yield* emit({
            ...(yield* buildBase({ threadId, requestId })),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision: frame.outcome,
            },
          });
          break;
        }
        case "question/requested": {
          const requestId = ApprovalRequestId.make(input.rpcId);
          context.pendingQuestions.set(requestId, {
            rpcId: input.rpcId,
            questions: frame.questions,
          });
          yield* emit({
            ...(yield* buildBase({ threadId, requestId })),
            type: "user-input.requested",
            payload: { questions: normalizeQuestions(frame.questions) },
          });
          break;
        }
        case "question/resolved": {
          const requestId = ApprovalRequestId.make(frame.questionRpcId);
          const pending = context.pendingQuestions.get(requestId);
          if (pending === undefined) {
            yield* emit({
              ...(yield* buildBase({ threadId })),
              type: "runtime.error",
              payload: {
                message: `DeepSeek Harness resolved unknown question '${frame.questionRpcId}'.`,
                class: "provider_error",
              },
            });
            break;
          }
          context.pendingQuestions.delete(requestId);
          yield* emit({
            ...(yield* buildBase({ threadId, requestId })),
            type: "user-input.resolved",
            payload: { answers: frame.outcome === "answered" ? (pending.answers ?? {}) : {} },
          });
          break;
        }
        default:
          break;
      }
    });

    const failHost = Effect.fn("DeepSeekHarnessAdapter.failHost")(function* (
      host: SharedHost,
      cause: unknown,
      errorClass: "provider_error" | "transport_error" = "transport_error",
    ) {
      if (host.failed || host.stopping) return;
      host.failed = true;
      yield* emitHostFailure(cause, errorClass);
    });

    const startPumps = Effect.fn("DeepSeekHarnessAdapter.startPumps")(function* (host: SharedHost) {
      const abortController = new AbortController();
      yield* Stream.fromAsyncIterable(
        host.process.client.muxEvents(abortController.signal),
        (cause) => asAdapterError("events.mux", cause),
      ).pipe(
        Stream.runForEach((frame) => handleMuxFrame(frame)),
        Effect.catch((cause) => failHost(host, cause)),
        Effect.forkIn(host.scope),
      );
      yield* Stream.fromAsyncIterable(
        host.process.client.hostEvents(abortController.signal),
        (cause) => asAdapterError("events.host", cause),
      ).pipe(
        Stream.runForEach((frame) => {
          if (frame.payload.type === "stream/error") {
            return Effect.fail(asAdapterError("events.host", frame.payload.error.message));
          }
          if (
            frame.payload.type !== "host/session-status" &&
            frame.payload.type !== "host/agent-error"
          ) {
            return Effect.void;
          }
          const threadId = threadsByProviderSession.get(frame.payload.sessionId);
          const context = threadId === undefined ? undefined : sessions.get(threadId);
          if (threadId === undefined || context === undefined) return Effect.void;
          if (frame.payload.type === "host/session-status") {
            const statusFrame = frame.payload;
            return Effect.gen(function* () {
              if (!statusFrame.running && context.turnBoundary !== undefined) {
                yield* Deferred.succeed(context.turnBoundary.completed, undefined).pipe(
                  Effect.ignore,
                );
              }
              const updatedAt = yield* nowIso;
              context.session = {
                ...context.session,
                status: statusFrame.running ? "running" : "ready",
                updatedAt,
              };
              yield* emit({
                ...(yield* buildBase({
                  threadId,
                  ...(context.activeTurnId === undefined ? {} : { turnId: context.activeTurnId }),
                })),
                type: "session.state.changed",
                payload: { state: statusFrame.running ? "running" : "ready" },
              });
            });
          }
          if (frame.payload.type !== "host/agent-error") return Effect.void;
          const agentError = frame.payload;
          return buildBase({
            threadId,
            ...(context.activeTurnId === undefined ? {} : { turnId: context.activeTurnId }),
          }).pipe(
            Effect.flatMap((base) =>
              emit({
                ...base,
                type: "runtime.error",
                payload: {
                  message: deepSeekUserMessage(agentError.message),
                  class: "provider_error",
                },
              }),
            ),
          );
        }),
        Effect.catch((cause) => failHost(host, cause)),
        Effect.forkIn(host.scope),
      );
      yield* host.process.exitCode.pipe(
        Effect.flatMap((code) => {
          if (host.stopping) return Effect.void;
          return failHost(
            host,
            new Error(`DeepSeek Harness host exited unexpectedly with code ${code}.`),
            "provider_error",
          );
        }),
        Effect.forkIn(host.scope),
      );
      // Register this after the pump fibers so LIFO scope teardown aborts their
      // pending WebSocket reads before waiting for the fibers to finish.
      yield* Scope.addFinalizer(
        host.scope,
        Effect.sync(() => abortController.abort()),
      );
    });

    const ensureHost = Effect.fn("DeepSeekHarnessAdapter.ensureHost")(function* () {
      if (sharedHost !== undefined && !sharedHost.failed) return sharedHost;
      if (sharedHost !== undefined) {
        sharedHost.stopping = true;
        yield* Scope.close(sharedHost.scope, Exit.void).pipe(Effect.ignore);
        sharedHost = undefined;
        for (const context of sessions.values()) {
          context.permissionPreset = undefined;
          context.interactionMode = "unknown";
        }
      }
      const scope = yield* Scope.make();
      const started = yield* runtime
        .startHost({
          binaryPath: settings.binaryPath,
          ...(options?.environment === undefined ? {} : { environment: options.environment }),
          ...(settings.launchArgs === undefined ? {} : { launchArgs: settings.launchArgs }),
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => asAdapterError("startHost", cause)),
          Effect.tapError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
        );
      const host = { scope, process: started, failed: false, stopping: false } satisfies SharedHost;
      sharedHost = host;
      yield* startPumps(host);
      return host;
    });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context === undefined
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(context);
    };

    const applyModes = Effect.fn("DeepSeekHarnessAdapter.applyModes")(function* (
      context: SessionContext,
      interactionMode: "default" | "plan",
    ) {
      const host = yield* ensureHost();
      const permissionPreset = runtimePreset(context.session.runtimeMode);
      if (context.permissionPreset !== permissionPreset) {
        const permission = yield* Effect.tryPromise({
          try: () =>
            host.process.client.executeCommand(
              context.providerSessionId,
              `/permission ${permissionPreset}`,
            ),
          catch: (cause) => asAdapterError("commands/execute permission", cause),
        });
        if (!permission.matched || permission.outcome === "error") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "commands/execute permission",
            detail: permission.text ?? "DeepSeek Harness did not accept /permission.",
          });
        }
        context.permissionPreset = permissionPreset;
      }
      if (context.interactionMode !== interactionMode) {
        const plan = yield* Effect.tryPromise({
          try: () =>
            host.process.client.executeCommand(
              context.providerSessionId,
              interactionMode === "plan" ? "/plan" : "/plan off",
            ),
          catch: (cause) => asAdapterError("commands/execute plan", cause),
        });
        if (!plan.matched || plan.outcome === "error") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "commands/execute plan",
            detail: plan.text ?? "DeepSeek Harness did not accept the plan-mode command.",
          });
        }
        context.interactionMode = interactionMode;
      }
    });

    const applyModelSelection = Effect.fn("DeepSeekHarnessAdapter.applyModelSelection")(function* (
      providerSessionId: string,
      modelSelection: ModelSelection,
    ) {
      if (modelSelection.instanceId !== instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "selectModel",
          issue: `Model selection belongs to '${modelSelection.instanceId}', expected '${instanceId}'.`,
        });
      }
      const separator = modelSelection.model.indexOf("/");
      if (separator <= 0 || separator === modelSelection.model.length - 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "selectModel",
          issue: "DeepSeek Harness model selections use 'provider/model'.",
        });
      }
      const host = yield* ensureHost();
      const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      yield* Effect.tryPromise({
        try: () =>
          host.process.client.selectModel({
            sessionId: providerSessionId,
            provider: modelSelection.model.slice(0, separator),
            model: modelSelection.model.slice(separator + 1),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          }),
        catch: (cause) => asAdapterError("session.selectModel", cause),
      });
    });

    const waitForTurnBoundary = Effect.fn("DeepSeekHarnessAdapter.waitForTurnBoundary")(function* (
      context: SessionContext,
    ) {
      const boundary = context.turnBoundary;
      if (boundary === undefined) return;
      const settled = yield* Deferred.await(boundary.completed).pipe(
        Effect.timeoutOption("5 seconds"),
      );
      if (Option.isNone(settled)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.cancel",
          detail: "DeepSeek Harness did not become idle within 5 seconds after cancellation.",
        });
      }
    });

    const startSession: DeepSeekHarnessAdapterShape["startSession"] = Effect.fn(
      "DeepSeekHarnessAdapter.startSession",
    )(function* (input) {
      const host = yield* ensureHost();
      const cwd = input.cwd ?? serverConfig.cwd;
      const resume = isResumeCursor(input.resumeCursor) ? input.resumeCursor : undefined;
      let providerSessionId: string;
      let lastSeq = -1;
      const historyEvents: Array<DeepSeekSessionEvent> = [];
      if (resume !== undefined) {
        const listed = yield* Effect.tryPromise({
          try: () => host.process.client.listSessions(),
          catch: (cause) => asAdapterError("session.list", cause),
        });
        const existing = listed.find((session) => session.sessionId === resume.sessionId);
        if (existing === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.resume",
            detail: `DeepSeek Harness session '${resume.sessionId}' no longer exists.`,
          });
        }
        if (
          existing.cwd !== undefined &&
          !(yield* isSameDeepSeekDirectory(fileSystem, path, existing.cwd, cwd))
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `The saved DeepSeek Harness session belongs to '${existing.cwd}', not '${cwd}'.`,
          });
        }
        providerSessionId = existing.sessionId;
        let beforeSeq: number | undefined;
        do {
          const page = yield* Effect.tryPromise({
            try: () =>
              host.process.client.history({
                sessionId: providerSessionId,
                ...(beforeSeq === undefined ? {} : { beforeSeq }),
              }),
            catch: (cause) => asAdapterError("session.history", cause),
          });
          for (const entry of page.events) {
            historyEvents.push(entry.event);
            lastSeq = Math.max(lastSeq, entry.event.seq);
          }
          beforeSeq = page.events[0]?.event.seq;
          if (!page.hasMore || beforeSeq === undefined) break;
        } while (true);
      } else {
        const created = yield* Effect.tryPromise({
          try: () => host.process.client.createSession({ cwd }),
          catch: (cause) => asAdapterError("session.create", cause),
        });
        providerSessionId = created.sessionId;
      }

      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
        threadId: input.threadId,
        resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: providerSessionId },
        createdAt,
        updatedAt: createdAt,
      };
      const context: SessionContext = {
        session,
        providerSessionId,
        translator: new DeepSeekEventTranslator(),
        pendingApprovals: new Map(),
        pendingQuestions: new Map(),
        turns: historicalTurns(providerSessionId, historyEvents),
        lastSeq,
        activeTurnId: undefined,
        interactionMode: "unknown",
        permissionPreset: undefined,
        turnBoundary: undefined,
      };
      yield* applyModes(context, "default");
      if (input.modelSelection !== undefined) {
        yield* applyModelSelection(providerSessionId, input.modelSelection);
      }
      sessions.set(input.threadId, context);
      threadsByProviderSession.set(providerSessionId, input.threadId);
      yield* emit({
        ...(yield* buildBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "DeepSeek Harness session started" },
      });
      yield* emit({
        ...(yield* buildBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: { providerThreadId: providerSessionId },
      });
      return session;
    });

    const sendTurn: DeepSeekHarnessAdapterShape["sendTurn"] = Effect.fn(
      "DeepSeekHarnessAdapter.sendTurn",
    )(function* (input) {
      const context = yield* requireSession(input.threadId);
      if (context.activeTurnId !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "DeepSeek Harness steering is not enabled in the MVP; interrupt or wait first.",
        });
      }
      const text = input.input?.trim();
      const imageContent = yield* Effect.forEach(
        input.attachments ?? [],
        (
          attachment,
        ): Effect.Effect<
          DeepSeekImageContent,
          ProviderAdapterRequestError | ProviderAdapterValidationError
        > =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (attachmentPath === null) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            if (!DEEPSEEK_IMAGE_MEDIA_TYPES.has(attachment.mimeType as DeepSeekImageMediaType)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `DeepSeek Harness does not support '${attachment.mimeType}' image attachments.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.prompt",
                    detail: `Failed to read attachment '${attachment.name}'.`,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              mediaType: attachment.mimeType as DeepSeekImageMediaType,
              data: Buffer.from(bytes).toString("base64"),
              name: attachment.name,
            };
          }),
        { concurrency: 1 },
      );
      if (!text && imageContent.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "DeepSeek Harness turns require text input or at least one image.",
        });
      }
      const host = yield* ensureHost();
      const interactionMode = input.interactionMode ?? "default";
      yield* applyModes(context, interactionMode);
      const modelSelection = input.modelSelection;
      if (modelSelection !== undefined) {
        yield* applyModelSelection(context.providerSessionId, modelSelection);
      }
      const turnId = TurnId.make(`deepseek-turn-${yield* makeId}`);
      const completed = yield* Deferred.make<void>();
      context.activeTurnId = turnId;
      context.turnBoundary = { turnId, completed };
      context.translator.setPendingTurnId(turnId);
      context.turns.push({ id: turnId, items: [] });
      const updatedAt = yield* nowIso;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        model: modelSelection?.model ?? context.session.model,
        updatedAt,
      };
      yield* Effect.tryPromise({
        try: () =>
          host.process.client.prompt({
            sessionId: context.providerSessionId,
            mode: "queue",
            content: [
              ...(text === undefined ? [] : [{ type: "text" as const, text }]),
              ...imageContent,
            ],
          }),
        catch: (cause) => asAdapterError("session.prompt", cause),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            context.activeTurnId = undefined;
            context.turnBoundary = undefined;
            context.translator.clearPendingTurnId(turnId);
            context.turns.pop();
            const { activeTurnId: _activeTurnId, ...session } = context.session;
            context.session = { ...session, status: "ready", updatedAt };
          }),
        ),
      );
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: context.providerSessionId },
      };
    });

    const interruptTurn: DeepSeekHarnessAdapterShape["interruptTurn"] = Effect.fn(
      "DeepSeekHarnessAdapter.interruptTurn",
    )(function* (threadId, turnId) {
      const context = yield* requireSession(threadId);
      if (context.activeTurnId === undefined) return;
      if (turnId !== undefined && turnId !== context.activeTurnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "interruptTurn",
          issue: `Turn '${turnId}' is not the active DeepSeek Harness turn.`,
        });
      }
      const host = yield* ensureHost();
      yield* Effect.tryPromise({
        try: () => host.process.client.cancel(context.providerSessionId),
        catch: (cause) => asAdapterError("session.cancel", cause),
      });
      yield* waitForTurnBoundary(context);
    });

    const respondToRequest: DeepSeekHarnessAdapterShape["respondToRequest"] = Effect.fn(
      "DeepSeekHarnessAdapter.respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (pending === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respond approval",
          detail: `Unknown DeepSeek approval '${requestId}'.`,
        });
      }
      const host = yield* ensureHost();
      if (decision === "acceptForSession" || decision === "acceptAlways") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "DeepSeek Harness currently supports Allow once or Reject only.",
        });
      }
      yield* Effect.tryPromise({
        try: () =>
          host.process.client.respondToApproval({
            rpcId: pending.rpcId,
            sessionId: context.providerSessionId,
            approvalId: pending.approvalId,
            outcome: decision === "accept" ? "allowed-once" : "rejected",
          }),
        catch: (cause) => asAdapterError("respond approval", cause),
      });
    });

    const respondToUserInput: DeepSeekHarnessAdapterShape["respondToUserInput"] = Effect.fn(
      "DeepSeekHarnessAdapter.respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingQuestions.get(requestId);
      if (pending === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respond question",
          detail: `Unknown DeepSeek question '${requestId}'.`,
        });
      }
      const host = yield* ensureHost();
      const previousAnswers = pending.answers;
      pending.answers = answers;
      yield* Effect.tryPromise({
        try: () =>
          host.process.client.respondToQuestion({
            rpcId: pending.rpcId,
            sessionId: context.providerSessionId,
            answers: questionAnswers(pending.questions, answers),
          }),
        catch: (cause) => asAdapterError("respond question", cause),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (previousAnswers === undefined) delete pending.answers;
            else pending.answers = previousAnswers;
          }),
        ),
      );
    });

    const stopSession: DeepSeekHarnessAdapterShape["stopSession"] = Effect.fn(
      "DeepSeekHarnessAdapter.stopSession",
    )(function* (threadId) {
      const context = yield* requireSession(threadId);
      const host = sharedHost;
      if (context.activeTurnId !== undefined && host !== undefined) {
        yield* Effect.tryPromise({
          try: () => host.process.client.cancel(context.providerSessionId),
          catch: (cause) => asAdapterError("session.cancel", cause),
        });
        yield* waitForTurnBoundary(context);
      }
      sessions.delete(threadId);
      threadsByProviderSession.delete(context.providerSessionId);
      yield* emit({
        ...(yield* buildBase({ threadId })),
        type: "session.exited",
        payload: {
          reason: "DeepSeek Harness session detached",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    });

    const stopAll: DeepSeekHarnessAdapterShape["stopAll"] = Effect.fn(
      "DeepSeekHarnessAdapter.stopAll",
    )(function* () {
      sessions.clear();
      threadsByProviderSession.clear();
      const host = sharedHost;
      sharedHost = undefined;
      if (host !== undefined) {
        host.stopping = true;
        yield* Scope.close(host.scope, Exit.void).pipe(Effect.ignore);
      }
    });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map(({ session }) => session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((context) => ({ threadId, turns: context.turns })),
        ),
      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "DeepSeek Harness does not expose provider-side history rollback.",
          });
        }),
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEvents),
    } satisfies DeepSeekHarnessAdapterShape;
  });
}

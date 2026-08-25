import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessRuntimeShape,
} from "../deepseekHarnessRuntime.ts";
import { DeepSeekHostClient } from "../deepseekHarness/DeepSeekHostClient.ts";
import type {
  DeepSeekHostFrame,
  DeepSeekModelSelection,
  DeepSeekMuxFrame,
  DeepSeekSessionEvent,
  DeepSeekSessionSummary,
} from "../deepseekHarness/DeepSeekHostProtocol.ts";
import { isSameDeepSeekDirectory, makeDeepSeekHarnessAdapter } from "./DeepSeekHarnessAdapter.ts";

type StreamFrame<A> = { readonly rpcId: string; readonly payload: A };

class PushAsyncIterable<A> implements AsyncIterable<A> {
  readonly #queued: Array<A> = [];
  readonly #waiting: Array<(result: IteratorResult<A>) => void> = [];
  #closed = false;

  push(value: A): void {
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) waiting({ done: false, value });
    else this.#queued.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return {
      next: () => {
        const value = this.#queued.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: () => {
        this.#closed = true;
        for (const resolve of this.#waiting.splice(0)) {
          resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

class FakeDeepSeekHostClient extends DeepSeekHostClient {
  readonly mux = new PushAsyncIterable<StreamFrame<DeepSeekMuxFrame>>();
  readonly host = new PushAsyncIterable<StreamFrame<DeepSeekHostFrame>>();
  readonly commands: Array<string> = [];
  readonly prompts: Array<string> = [];
  readonly selections: Array<{ readonly sessionId: string } & DeepSeekModelSelection> = [];
  readonly approvalResponses: Array<unknown> = [];
  readonly questionResponses: Array<unknown> = [];
  readonly sessionSummaries: Array<DeepSeekSessionSummary> = [];
  readonly historyEvents: Array<DeepSeekSessionEvent> = [];
  #session = 0;

  constructor() {
    super({ baseUrl: "http://127.0.0.1:3080" });
  }

  override async listSessions() {
    return this.sessionSummaries;
  }

  override async history() {
    return {
      events: this.historyEvents.map((event) => ({ event })),
      hasMore: false,
    };
  }

  override async createSession(_input: {
    readonly cwd: string;
    readonly sessionId?: string;
    readonly agentPreset?: string;
  }) {
    this.#session += 1;
    return { sessionId: `session-${this.#session}` };
  }

  override async executeCommand(_sessionId: string, command: string) {
    this.commands.push(command);
    return {
      matched: true,
      commandId: `command-${this.commands.length}`,
      outcome: "success" as const,
    };
  }

  override async selectModel(input: { readonly sessionId: string } & DeepSeekModelSelection) {
    this.selections.push(input);
    return input;
  }

  override async prompt(input: {
    readonly sessionId: string;
    readonly mode: "queue" | "steer";
    readonly content: ReadonlyArray<
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "image";
          readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
          readonly data: string;
          readonly name?: string;
        }
    >;
    readonly clientTimeZone?: string;
  }) {
    this.prompts.push(
      input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    );
  }

  override async respondToApproval(input: Parameters<DeepSeekHostClient["respondToApproval"]>[0]) {
    this.approvalResponses.push(input);
  }

  override async respondToQuestion(input: Parameters<DeepSeekHostClient["respondToQuestion"]>[0]) {
    this.questionResponses.push(input);
  }

  override muxEvents() {
    return this.mux;
  }

  override hostEvents() {
    return this.host;
  }
}

function makeTestLayer(client: FakeDeepSeekHostClient) {
  const runtime: DeepSeekHarnessRuntimeShape = {
    runCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    readVersion: () => Effect.succeed("0.1.1-rc.2"),
    startHost: () =>
      Effect.succeed({
        url: "http://127.0.0.1:3080",
        client,
        exitCode: Effect.never,
      }),
  };
  return Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-deepseek-adapter-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(DeepSeekHarnessRuntime, runtime),
    NodeServices.layer,
  );
}

function sessionEvent(seq: number, type: string, data: unknown): StreamFrame<DeepSeekMuxFrame> {
  return {
    rpcId: `rpc-${seq}`,
    payload: {
      type: "session/event",
      sessionId: "session-1",
      event: { seq, time: 1_700_000_000_000 + seq, type, data },
    },
  };
}

it.effect("accepts lexically equivalent resume directories", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    assert.isTrue(
      yield* isSameDeepSeekDirectory(fileSystem, path, process.cwd(), `${process.cwd()}/.`),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resumes the stored native session and suppresses replayed sequence numbers", () => {
  const client = new FakeDeepSeekHostClient();
  client.sessionSummaries.push({
    sessionId: "session-1",
    cwd: process.cwd(),
    updatedAt: 1_700_000_000_000,
    running: false,
    blank: false,
  });
  client.historyEvents.push(
    { type: "turn/start", seq: 1, time: 100, data: { turn: 1 } },
    { type: "turn/end", seq: 2, time: 101, data: { turn: 1, reason: { kind: "completed" } } },
  );
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter({ binaryPath: "dsh" });
    const threadId = ThreadId.make("thread-resumed");
    const collected = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
      Effect.forkChild,
    );
    const session = yield* adapter.startSession({
      threadId,
      cwd: `${process.cwd()}/.`,
      runtimeMode: "auto",
      resumeCursor: { schemaVersion: 1, sessionId: "session-1" },
    });
    client.mux.push(sessionEvent(2, "session/title", { title: "Ignored replay" }));
    client.mux.push(sessionEvent(3, "session/title", { title: "Continued work" }));

    const events = Array.from(yield* Fiber.join(collected));
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["session.started", "thread.started", "thread.metadata.updated"],
    );
    assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "session-1" });
    const snapshot = yield* adapter.readThread(threadId);
    assert.strictEqual(snapshot.turns.length, 1);
    assert.strictEqual(snapshot.turns[0]?.items.length, 2);
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

it.effect("runs a model-selected turn end to end and emits canonical events", () => {
  const client = new FakeDeepSeekHostClient();
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter(
      { binaryPath: "dsh" },
      { instanceId: ProviderInstanceId.make("deepseek_work") },
    );
    const collected = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
      Effect.forkChild,
    );
    const threadId = ThreadId.make("thread-deepseek");
    const session = yield* adapter.startSession({
      provider: ProviderDriverKind.make("deepseekHarness"),
      providerInstanceId: ProviderInstanceId.make("deepseek_work"),
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const started = yield* adapter.sendTurn({
      threadId,
      input: "Inspect the repository",
      modelSelection: {
        instanceId: ProviderInstanceId.make("deepseek_work"),
        model: "deepseek-official/deepseek-chat",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });

    client.mux.push(sessionEvent(1, "turn/start", { turn: 1 }));
    client.mux.push(
      sessionEvent(2, "assistant/chunk", {
        turn: 1,
        step: 0,
        chunk: { type: "reasoning-delta", index: 0, text: "Checking" },
      }),
    );
    client.mux.push(
      sessionEvent(3, "assistant/chunk", {
        turn: 1,
        step: 0,
        chunk: { type: "text-delta", index: 1, text: "Found it" },
      }),
    );
    client.mux.push(sessionEvent(4, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const events = Array.from(yield* Fiber.join(collected));
    assert.deepStrictEqual(
      events.map((event: ProviderRuntimeEvent) => event.type),
      [
        "session.started",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.started",
        "content.delta",
        "turn.completed",
      ],
    );
    assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "session-1" });
    assert.deepStrictEqual(client.commands, ["/permission danger-full-access", "/plan off"]);
    assert.deepStrictEqual(client.prompts, ["Inspect the repository"]);
    assert.deepStrictEqual(client.selections, [
      {
        sessionId: "session-1",
        provider: "deepseek-official",
        model: "deepseek-chat",
        reasoningEffort: "high",
      },
    ]);
    assert.strictEqual(started.threadId, threadId);

    const snapshot = yield* adapter.readThread(threadId);
    assert.strictEqual(snapshot.turns.length, 1);
    assert.strictEqual(snapshot.turns[0]?.items.length, 4);
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

it.effect("maps every runtime mode and resets native plan mode", () => {
  const client = new FakeDeepSeekHostClient();
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter({ binaryPath: "dsh" });
    const modes = [
      ["approval-required", "read-only"],
      ["auto-accept-edits", "workspace-write"],
      ["auto", "workspace-write"],
      ["full-access", "danger-full-access"],
    ] as const;
    for (const [index, [runtimeMode]] of modes.entries()) {
      yield* adapter.startSession({
        threadId: ThreadId.make(`thread-mode-${index}`),
        cwd: process.cwd(),
        runtimeMode,
      });
    }
    assert.deepStrictEqual(
      client.commands,
      modes.flatMap(([, preset]) => [`/permission ${preset}`, "/plan off"]),
    );
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

it.effect("routes approvals and structured questions back to their original RPC ids", () => {
  const client = new FakeDeepSeekHostClient();
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter({ binaryPath: "dsh" });
    const threadId = ThreadId.make("thread-interactions");
    const collected = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
      Effect.forkChild,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    client.mux.push({
      rpcId: "approval-rpc",
      payload: {
        type: "approval/requested",
        sessionId: "session-1",
        approvalId: "approval-1",
        toolName: "bash",
      },
    });
    client.mux.push({
      rpcId: "question-rpc",
      payload: {
        type: "question/requested",
        sessionId: "session-1",
        questions: [{ id: "target", question: "Which target?", options: [{ label: "web" }] }],
      },
    });
    yield* Fiber.join(collected);
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-1"), "accept");
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("question-rpc"), {
      target: "web",
    });

    assert.deepInclude(client.approvalResponses[0] as object, {
      rpcId: "approval-rpc",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });
    assert.deepInclude(client.questionResponses[0] as object, {
      rpcId: "question-rpc",
      answers: [{ id: "target", selected: ["web"] }],
    });
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

it.effect("fails an active turn visibly when the host event stream fails", () => {
  const client = new FakeDeepSeekHostClient();
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter({ binaryPath: "dsh" });
    const threadId = ThreadId.make("thread-host-failure");
    const collected = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
      Effect.forkChild,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "auto" });
    yield* adapter.sendTurn({ threadId, input: "Run the task" });
    client.mux.push(sessionEvent(1, "turn/start", { turn: 1 }));
    client.mux.push({
      rpcId: "stream-error",
      payload: { type: "stream/error", error: { code: "closed", message: "socket closed" } },
    });

    const events = Array.from(yield* Fiber.join(collected));
    assert.deepInclude(events.find((event) => event.type === "turn.completed")?.payload as object, {
      state: "failed",
      stopReason: "host-failure",
    });
    assert.deepInclude(
      events.find((event) => event.type === "session.state.changed")?.payload as object,
      { state: "error" },
    );
    assert.strictEqual((yield* adapter.listSessions())[0]?.status, "error");
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

it.effect("rolls back local turn state when prompt admission fails", () => {
  class RejectingPromptClient extends FakeDeepSeekHostClient {
    override async prompt() {
      throw new Error("prompt rejected");
    }
  }
  const client = new RejectingPromptClient();
  return Effect.gen(function* () {
    const adapter = yield* makeDeepSeekHarnessAdapter({ binaryPath: "dsh" });
    const threadId = ThreadId.make("thread-prompt-rejected");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "auto" });

    const first = yield* Effect.exit(adapter.sendTurn({ threadId, input: "First" }));
    const second = yield* Effect.exit(adapter.sendTurn({ threadId, input: "Second" }));

    assert.strictEqual(first._tag, "Failure");
    assert.strictEqual(second._tag, "Failure");
    assert.strictEqual((yield* adapter.listSessions())[0]?.status, "ready");
    assert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, []);
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(client)));
});

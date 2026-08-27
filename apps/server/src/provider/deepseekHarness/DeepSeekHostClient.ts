import * as NodeCrypto from "node:crypto";

import { Schema } from "effect";

import {
  DeepSeekAcceptedValue,
  DeepSeekCommandValue,
  DeepSeekCredentialsDescribeValue,
  DeepSeekHostFrame,
  DeepSeekLlmModelsValue,
  DeepSeekMuxFrame,
  DeepSeekRpcReceipt,
  DeepSeekServerRequest,
  DeepSeekServerResponse,
  DeepSeekSessionCreateValue,
  DeepSeekSessionHistoryValue,
  DeepSeekSessionListValue,
  DeepSeekSessionModelsValue,
  DeepSeekSessionSelectModelValue,
  type DeepSeekHistoryEntry,
  type DeepSeekHostFrame as DeepSeekHostFrameType,
  type DeepSeekModelSelection,
  type DeepSeekMuxFrame as DeepSeekMuxFrameType,
  type DeepSeekQuestion,
  type DeepSeekSessionModelsValue as DeepSeekSessionModelsValueType,
  type DeepSeekSessionSummary,
} from "./DeepSeekHostProtocol.ts";

export class DeepSeekHostClientError extends Error {
  readonly operation: string;
  readonly detail: string;

  constructor(operation: string, detail: string, options?: ErrorOptions) {
    super(`${operation}: ${detail}`, options);
    this.name = "DeepSeekHostClientError";
    this.operation = operation;
    this.detail = detail;
  }
}

type DeepSeekStreamFrame<A> = {
  readonly rpcId: string;
  readonly payload: A;
};

function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  operation: string,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch (cause) {
    throw new DeepSeekHostClientError(operation, "received an incompatible wire payload", {
      cause,
    });
  }
}

function socketUrl(baseUrl: URL, path: string): URL {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export class DeepSeekHostClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocket: typeof globalThis.WebSocket;

  constructor(input: {
    readonly baseUrl: string | URL;
    readonly fetch?: typeof globalThis.fetch;
    readonly webSocket?: typeof globalThis.WebSocket;
  }) {
    this.#baseUrl = new URL(input.baseUrl);
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#webSocket = input.webSocket ?? globalThis.WebSocket;
  }

  async #call<S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    payload: unknown,
    valueSchema: S,
    signal?: AbortSignal,
  ): Promise<S["Type"]> {
    const rpcId = NodeCrypto.randomUUID();
    let response: Response;
    try {
      response = await this.#fetch(new URL(`/api/${method}`, this.#baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new DeepSeekHostClientError(method, "transport request failed", { cause });
    }
    if (!response.ok) {
      throw new DeepSeekHostClientError(method, `transport returned HTTP ${response.status}`);
    }
    const envelope = decode(DeepSeekServerResponse, await response.json(), method);
    if (envelope.rpcId !== rpcId) {
      throw new DeepSeekHostClientError(method, "response rpcId did not match the request");
    }
    if (!envelope.result.ok) {
      throw new DeepSeekHostClientError(
        method,
        `${envelope.result.error.code}: ${envelope.result.error.message}`,
      );
    }
    return decode(valueSchema, envelope.result.value, method);
  }

  listSessions(signal?: AbortSignal): Promise<ReadonlyArray<DeepSeekSessionSummary>> {
    return this.#call("session.list", {}, DeepSeekSessionListValue, signal).then(
      (value) => value.items,
    );
  }

  createSession(
    input: { readonly cwd: string; readonly sessionId?: string; readonly agentPreset?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly sessionId: string; readonly agentPreset?: string }> {
    return this.#call("session.create", input, DeepSeekSessionCreateValue, signal);
  }

  history(
    input: {
      readonly sessionId: string;
      readonly beforeSeq?: number;
      readonly maxMessages?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly events: ReadonlyArray<DeepSeekHistoryEntry>; readonly hasMore: boolean }> {
    return this.#call("session.history", input, DeepSeekSessionHistoryValue, signal);
  }

  models(sessionId: string, signal?: AbortSignal): Promise<DeepSeekSessionModelsValueType> {
    return this.#call("session.models", { sessionId }, DeepSeekSessionModelsValue, signal);
  }

  modelCatalog(signal?: AbortSignal): Promise<DeepSeekLlmModelsValue> {
    return this.#call("llm.models", {}, DeepSeekLlmModelsValue, signal);
  }

  describeCredentials(refs: ReadonlyArray<string>, signal?: AbortSignal) {
    return this.#call(
      "credentials.describe",
      { refs },
      DeepSeekCredentialsDescribeValue,
      signal,
    ).then((value) => value.credentials);
  }

  selectModel(
    input: { readonly sessionId: string } & DeepSeekModelSelection,
    signal?: AbortSignal,
  ): Promise<DeepSeekModelSelection> {
    return this.#call("session.selectModel", input, DeepSeekSessionSelectModelValue, signal).then(
      (value) => value.selected,
    );
  }

  prompt(
    input: {
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
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#call("session.prompt", input, DeepSeekAcceptedValue, signal).then(() => undefined);
  }

  cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    return this.#call("session.cancel", { sessionId }, DeepSeekAcceptedValue, signal).then(
      () => undefined,
    );
  }

  executeCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly matched: boolean;
    readonly commandId?: string;
    readonly outcome?: "success" | "error";
    readonly text?: string;
  }> {
    return this.#call(
      "commands/execute",
      { args: { agentId: sessionId, line: command, images: [] } },
      DeepSeekCommandValue,
      signal,
    ).then((execution) =>
      execution === undefined
        ? { matched: false }
        : {
            matched: true,
            commandId: execution.commandId,
            outcome: execution.result.kind,
            ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
          },
    );
  }

  async respondToApproval(input: {
    readonly rpcId: string;
    readonly sessionId: string;
    readonly approvalId: string;
    readonly outcome: "allowed-once" | "rejected";
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.#respond(
      input.rpcId,
      {
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        outcome: input.outcome,
      },
      input.signal,
    );
  }

  async respondToQuestion(input: {
    readonly rpcId: string;
    readonly sessionId: string;
    readonly answers: ReadonlyArray<{
      readonly id: DeepSeekQuestion["id"];
      readonly selected: ReadonlyArray<string>;
      readonly custom?: string;
    }>;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.#respond(
      input.rpcId,
      { sessionId: input.sessionId, answer: { answers: input.answers } },
      input.signal,
    );
  }

  async #respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.#fetch(new URL("/api/respond", this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value } }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new DeepSeekHostClientError("respond", `transport returned HTTP ${response.status}`);
    }
    const receipt = decode(DeepSeekRpcReceipt, await response.json(), "respond");
    if (!receipt.accepted) {
      throw new DeepSeekHostClientError("respond", `host rejected response: ${receipt.reason}`);
    }
  }

  muxEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<DeepSeekStreamFrame<DeepSeekMuxFrameType>> {
    return this.#events("events.mux", DeepSeekMuxFrame, signal, onOpen);
  }

  hostEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<DeepSeekStreamFrame<DeepSeekHostFrameType>> {
    return this.#events("events.host", DeepSeekHostFrame, signal, onOpen);
  }

  async *#events<S extends Schema.ConstraintDecoder<unknown>>(
    endpoint: "events.mux" | "events.host",
    frameSchema: S,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<DeepSeekStreamFrame<S["Type"]>> {
    const socket = new this.#webSocket(socketUrl(this.#baseUrl, `/api/${endpoint}`));
    const queued: Array<DeepSeekStreamFrame<S["Type"]>> = [];
    let wake: (() => void) | undefined;
    let terminalError: Error | undefined;
    let closed = false;

    const notify = () => {
      const current = wake;
      wake = undefined;
      current?.();
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const envelope = decode(
          DeepSeekServerRequest,
          JSON.parse(typeof event.data === "string" ? event.data : String(event.data)),
          endpoint,
        );
        queued.push({
          rpcId: envelope.rpcId,
          payload: decode(frameSchema, envelope.payload, endpoint),
        });
      } catch (cause) {
        terminalError =
          cause instanceof Error
            ? cause
            : new DeepSeekHostClientError(endpoint, "failed to decode event", { cause });
      }
      notify();
    };
    const onError = () => {
      terminalError = new DeepSeekHostClientError(endpoint, "WebSocket failed");
      notify();
    };
    const onClose = () => {
      closed = true;
      notify();
    };
    const onAbort = () => socket.close();
    const onSocketOpen = () => onOpen?.();

    socket.addEventListener("open", onSocketOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (socket.readyState === this.#webSocket.OPEN) onSocketOpen();

    try {
      while (true) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (terminalError !== undefined) throw terminalError;
        if (signal.aborted) return;
        if (closed) {
          throw new DeepSeekHostClientError(endpoint, "WebSocket closed unexpectedly");
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onSocketOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (
        socket.readyState === this.#webSocket.OPEN ||
        socket.readyState === this.#webSocket.CONNECTING
      ) {
        socket.close();
      }
    }
  }
}

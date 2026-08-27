import { describe, expect, it } from "vite-plus/test";

import { DeepSeekHostClient, DeepSeekHostClientError } from "./DeepSeekHostClient.ts";

describe("DeepSeekHostClient", () => {
  it("uses the Web Host RPC envelope for session calls and generic commands", async () => {
    const requests: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const body = JSON.parse(String(init?.body)) as {
        readonly rpcId: string;
        readonly method?: string;
      } & Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      const value =
        url.pathname === "/api/session.list"
          ? {
              items: [
                {
                  sessionId: "session-1",
                  cwd: "/workspace",
                  updatedAt: 1_700_000_000_000,
                  running: false,
                  blank: false,
                },
              ],
            }
          : {
              commandId: "command-1",
              result: { kind: "success", text: "permission updated" },
            };
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new DeepSeekHostClient({
      baseUrl: "http://127.0.0.1:3080",
      fetch: fakeFetch,
    });

    await expect(client.listSessions()).resolves.toEqual([
      {
        sessionId: "session-1",
        cwd: "/workspace",
        updatedAt: 1_700_000_000_000,
        running: false,
        blank: false,
      },
    ]);
    await expect(
      client.executeCommand("session-1", "/permission workspace-write"),
    ).resolves.toEqual({
      matched: true,
      commandId: "command-1",
      outcome: "success",
      text: "permission updated",
    });
    expect(requests.map((request) => request.path)).toEqual([
      "/api/session.list",
      "/api/commands/execute",
    ]);
    expect(requests[1]?.body).toMatchObject({
      type: "client-request",
      method: "commands/execute",
      payload: {
        args: {
          agentId: "session-1",
          line: "/permission workspace-write",
          images: [],
        },
      },
    });
  });

  it("echoes the server request id when responding to an approval", async () => {
    let requestBody: unknown;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;
    const client = new DeepSeekHostClient({
      baseUrl: "http://127.0.0.1:3080",
      fetch: fakeFetch,
    });

    await client.respondToApproval({
      rpcId: "server-request-7",
      sessionId: "session-1",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });

    expect(requestBody).toEqual({
      type: "client-response",
      rpcId: "server-request-7",
      result: {
        ok: true,
        value: {
          sessionId: "session-1",
          approvalId: "approval-1",
          outcome: "allowed-once",
        },
      },
    });
  });

  it("reads credential configuration without requesting secret values", async () => {
    let requestBody: unknown;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly rpcId: string };
      requestBody = body;
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              credentials: {
                DEEPSEEK_API_KEY: {
                  configured: true,
                  source: "environment",
                  writable: true,
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new DeepSeekHostClient({
      baseUrl: "http://127.0.0.1:3080",
      fetch: fakeFetch,
    });

    await expect(client.describeCredentials(["DEEPSEEK_API_KEY"])).resolves.toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: "environment", writable: true },
    });
    expect(requestBody).toMatchObject({
      type: "client-request",
      method: "credentials.describe",
      payload: { refs: ["DEEPSEEK_API_KEY"] },
    });
  });

  it("rejects a mismatched response correlation id", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: "wrong-id",
          result: { ok: true, value: { items: [] } },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new DeepSeekHostClient({
      baseUrl: "http://127.0.0.1:3080",
      fetch: fakeFetch,
    });

    await expect(client.listSessions()).rejects.toBeInstanceOf(DeepSeekHostClientError);
  });

  it("reports WebSocket readiness and treats an unsolicited close as a failure", async () => {
    type Listener = (event: Event) => void;
    class ClosingWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readonly readyState = 3;
      readonly #listeners = new Map<string, Set<Listener>>();

      constructor() {
        queueMicrotask(() => {
          this.#emit("open");
          this.#emit("close");
        });
      }

      addEventListener(type: string, listener: Listener) {
        const listeners = this.#listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.#listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: Listener) {
        this.#listeners.get(type)?.delete(listener);
      }

      close() {}

      #emit(type: string) {
        for (const listener of this.#listeners.get(type) ?? []) listener(new Event(type));
      }
    }

    const client = new DeepSeekHostClient({
      baseUrl: "http://127.0.0.1:3080",
      webSocket: ClosingWebSocket as unknown as typeof WebSocket,
    });
    let opened = false;
    const events = client.muxEvents(new AbortController().signal, () => {
      opened = true;
    });
    const iterator = events[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/closed unexpectedly/i);
    expect(opened).toBe(true);
  });
});

# DeepSeek Harness provider

> For maintainers. This document defines the first-party DeepSeek Harness integration boundary.

## Decision

T3 Code integrates DeepSeek Harness as a built-in provider driver named `deepseekHarness`. The
driver owns a scoped local `dsh web` process and talks to its loopback Web Host API. It translates
DeepSeek's durable session events into T3's canonical provider runtime events.

The integration does not use DeepSeek's ACP adapter. ACP intentionally omits live reasoning, tool
activity, plans, token usage, history, and session resume. The SDK JSON-RPC adapter exposes the
durable event stream, but it does not expose approvals, cancellation, session close, or a
prompt-completion boundary. The Web Host API is the only shipped out-of-process surface that
already combines the lifecycle and interaction features required by a first-class T3 provider.

DeepSeek Harness is a developer preview. The initial compatibility target is exactly
`dsh-v0.1.1-rc.2`. T3 must reject an unverified version with an actionable provider diagnostic
instead of attempting to interpret an unknown wire format.

## Product contract

DeepSeek Harness appears in the same provider-instance setup used by Codex, Claude, Cursor, Grok,
and OpenCode. A configured instance must support:

- installation, authentication, version, model, and update status in the existing provider UI;
- new sessions, multiple turns, persisted history, and continuation after a T3 server restart;
- streamed assistant text, reasoning, tool calls and results, plans, and token usage;
- one-shot approvals, structured user questions, turn interruption, and session stop;
- images when the selected DeepSeek model advertises image input;
- subagent activity when DeepSeek emits durable subagent events;
- isolated provider instances with distinct environment and DeepSeek home directories;
- web, desktop, and mobile clients without a client-to-DeepSeek connection; and
- local, relay, and tunnel connections without embedding a loopback origin in a client bundle.

Provider-side destructive rollback is not part of the initial contract because DeepSeek exposes
forking rather than history truncation. `rollbackThread` fails explicitly, as Grok's adapter does,
while T3 workspace checkpoint restoration remains available independently. DeepSeek-native
session forking, queue editing, goals, jobs, and provider settings are not exposed until T3 has a
matching product-level contract.

## Existing seams

The implementation uses existing T3 boundaries:

- `ProviderDriver` decodes instance configuration and owns the scoped runtime.
- `ProviderAdapterShape` supplies session operations and a canonical event stream.
- `ProviderInstanceRegistry` supplies independent instance scopes and environment overlays.
- `makeManagedServerProvider` publishes installation, authentication, model, capability, version,
  and maintenance snapshots.
- `ProviderRuntimeIngestion` remains provider-neutral and persists translated runtime events.
- OpenCode's managed loopback server is the process-lifecycle precedent.
- Cursor and Grok's adapters are the interaction and canonical-event translation precedents.

No orchestration fork is introduced. Shared contracts change only where a first-class settings
schema or presentation metadata is required.

## Components

### `DeepSeekHarnessDriver`

The driver kind is `deepseekHarness`, with multiple instances allowed. Its settings are:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Existing hidden provider-instance switch. |
| `binaryPath` | `dsh` | DeepSeek Harness executable. |
| `homePath` | empty | Optional `DSH_HOME`; an empty value uses an instance-isolated T3 directory. |
| `launchArgs` | empty | Additional arguments appended after T3-owned Web flags. |

Credentials remain environment variables, primarily `DEEPSEEK_API_KEY`, managed through the
existing per-instance environment editor. Secrets are never copied into settings, logs, command
arguments, or provider snapshots.

`launchArgs` uses the repository's existing shell-argument parser. It rejects `--host`, `--port`,
and browser-opening flags because the runtime owns those values and must remain loopback-only.

The driver creates one runtime, adapter, text-generation service, and managed provider snapshot per
instance. Text generation uses an isolated DeepSeek session through the same runtime rather than a
second process.

### `DeepSeekHarnessRuntime`

The runtime follows `OpenCodeRuntime`:

1. Resolve the configured executable using the shared shell utilities.
2. run `dsh --version` and accept only the tested version;
3. create or reuse the instance's private `DSH_HOME`;
4. spawn `dsh web --host 127.0.0.1 --port 0 --no-open` with the merged instance environment;
5. parse the canonical `dsh web: http://127.0.0.1:<port>` readiness line;
6. establish the API event streams and complete a health query before reporting readiness; and
7. bind graceful termination and forced cleanup to the provider-instance scope.

The runtime is shared by all sessions belonging to that provider instance. It may connect to
loopback only. T3 clients continue to communicate solely with the T3 server.

The child receives a scrubbed, explicit environment. T3 supplies `DSH_HOME`, preserves sanctioned
provider-instance variables, disables browser opening through the command line, and does not expose
T3 pairing credentials to the child.

### `DeepSeekHostClient`

This module is a narrow client for the subset of the Web Host API T3 uses:

- `session.list`, `session.create`, `session.history`, `session.models`,
  `session.selectModel`, `session.prompt`, and `session.cancel`;
- the session mux and host-status streams; and
- the response channel for approvals and structured questions.

Wire envelopes and every consumed event are decoded at the boundary with Effect Schema. The client
must not depend on DeepSeek's host package at runtime: that package pulls most of the Harness plugin
graph into T3 and would couple two application runtimes. Unknown optional fields are ignored;
unknown event discriminants are logged and skipped. A malformed known event or envelope is a
protocol error and makes the affected session fail visibly.

The client owns request identifiers, reconnection, and stream cancellation. Reconnection opens new
streams, requests fresh session history from the last accepted sequence, and deduplicates by
DeepSeek session id plus event sequence. DeepSeek's current `since` stream parameter is not relied
on because it is documented as unimplemented.

### `DeepSeekHarnessAdapter`

The adapter keeps a T3-thread-to-DeepSeek-session table. A table entry contains the DeepSeek
session id, cwd, last accepted sequence, reconstructed turn snapshots, pending interactions, and
current activity state.

- `startSession` creates a DeepSeek session for a new thread or attaches to the persisted session
  named by the continuation identity.
- `sendTurn` optionally selects the requested model, submits ordered text/image content, and returns
  after admission. Completion is driven by the event stream.
- `interruptTurn` calls `session.cancel` and waits for the corresponding turn end or idle boundary.
- `respondToRequest` and `respondToUserInput` echo the original DeepSeek server-request id.
- `stopSession` cancels active work, waits for quiescence, and detaches T3 state without deleting
  DeepSeek history. The shared process remains alive while the provider instance exists.
- `readThread` returns the adapter's reconstructed snapshots.
- `rollbackThread` reports that DeepSeek Harness does not support provider-side rollback.

On startup, `listSessions` and history are used only for sessions T3 already owns. The adapter never
imports unrelated sessions from a user's standalone DeepSeek Web profile.

### Provider snapshot and maintenance

The provider probe reports separately:

- executable missing;
- executable present but version unsupported;
- Web runtime startup or protocol failure;
- missing or rejected API credentials; and
- available models and their input/context capabilities.

The snapshot uses DeepSeek's model directory instead of hard-coding it. If discovery is unavailable
before authentication, the provider shows no runnable models and explains the credential or
discovery failure.

Maintenance uses T3's package-managed provider helpers for the npm package
`@deepseek-ai/dsh`. Update discovery may advertise a newer release, but one-click installation must
not cross the adapter's tested compatibility range. Until a new release passes the compatibility
suite, the UI links to manual upgrade guidance rather than leaving the provider in a broken state.

## Event translation

The translation layer is exhaustive over the tested DeepSeek event vocabulary and preserves native
payloads in provider refs where T3 has no exact concept.

| DeepSeek event | T3 event |
| --- | --- |
| session attach/create | session and thread started/configured |
| `turn/start` | turn started |
| `turn/end` | turn completed or aborted from its reason |
| assistant reasoning chunks | reasoning item lifecycle and deltas |
| assistant text/image chunks | assistant item lifecycle and deltas |
| `tool/call` | tool item started |
| `tool/result` | tool item completed, including error metadata |
| `todo/write` | turn plan updated |
| assistant usage | thread token usage updated |
| approval requested/resolved | request opened/resolved |
| question requested/resolved | user input requested/resolved |
| subagent start/progress/end | task lifecycle events |
| host agent error/process exit | session error and exit |

Both live events and history replay pass through the same pure translator. Replay suppresses events
already ingested by sequence. This is the main defense against divergence between fresh, resumed,
and reconnected threads.

## Session and data flow

For a new thread, T3 starts or reuses the instance runtime, creates a DeepSeek session at the
project cwd, applies the selected model, stores the returned session id as provider continuation
metadata, and subscribes before the first prompt. DeepSeek persists its own native log under the
instance home; T3 persists the canonical projection it already owns.

For continuation, T3 starts the runtime, finds the exact stored DeepSeek session, loads its history,
reconstructs adapter state through the translator, then sends the next prompt. If the native session
is missing or its cwd conflicts, continuation fails visibly rather than silently creating a blank
conversation.

An event is acknowledged into adapter state only after schema validation and sequence checking.
T3's ordinary ingestion worker then turns it into persisted orchestration state. Approval and
question requests keep their DeepSeek request id in memory so the existing T3 response commands can
answer the correct pending promise.

## Failure and recovery

- Startup has a bounded readiness timeout and includes sanitized stderr in diagnostics.
- Unexpected child exit fails active turns, emits session exit events, and marks the provider
  unavailable. It never respawns during a turn.
- A later provider refresh or new session may restart the child once under the existing scoped
  runtime policy. Repeated crashes remain visible and do not form a restart loop.
- Event-stream loss pauses admission, reconnects once, reloads history from the last sequence, and
  resumes only after the gap is closed. Failure to close the gap fails the session.
- Duplicate events are ignored by native sequence. Sequence regression or conflicting duplicates
  are protocol errors.
- Cancellation, scope closure, and server shutdown drain pending responses and terminate only the
  recorded child process.
- Secret values and prompt content are excluded from ordinary diagnostics. Native event logging
  remains opt-in through the existing provider logger.

## Compatibility and remote behavior

The DeepSeek process is an implementation detail of the T3 server. Browser, desktop, and mobile
clients receive only canonical T3 contracts, so relay and tunnel behavior match other providers and
no DeepSeek port is reachable remotely. Multiple T3 devices can observe and answer the same pending
interaction through T3's existing event-sourced orchestration.

Compatibility is established by executable version plus a boot-time behavior probe, not version
text alone. The focused compatibility fixture must cover create, prompt, streamed reasoning, tool
events, approval, question, cancellation, history replay, and process shutdown. Supporting another
DeepSeek release means adding it to the tested range only after that fixture passes.

## Verification strategy

Pure unit tests cover:

- CLI version and readiness-line parsing;
- settings defaults, environment isolation, and secret redaction;
- every supported wire envelope and event schema;
- exhaustive event translation, replay deduplication, and turn reconstruction; and
- failure mapping for protocol, process, authentication, and unsupported rollback errors.

Adapter tests use a deterministic fake DeepSeek Host server to cover:

- new and resumed multi-turn sessions;
- assistant, reasoning, tools, plans, usage, images, approvals, and questions;
- interruption, disconnect recovery, session stop, and multi-instance isolation; and
- subprocess teardown without killing unrelated processes.

One opt-in compatibility test runs against the supported `dsh` release with a mock model transport,
so it exercises the real CLI and Host API without spending an API key. Existing provider registry,
settings, orchestration-ingestion, and maintenance tests gain a `deepseekHarness` case. Integrated
verification covers the web client first; desktop inherits the web surface, and mobile receives a
focused provider-selection and conversation pass through the same server.

## Rollout

The first release is first-class but compatibility-gated. The provider is selectable whenever its
driver is present; missing or incompatible installations render an actionable unavailable state.
There is no hidden generic-ACP fallback because that would silently remove core features.

Later DeepSeek capabilities should enter through the same adapter and canonical event model. Native
forking, queue management, goals, jobs, and broader model-provider routing remain possible without
changing the process boundary. If DeepSeek publishes a stable automation protocol with Web Host API
parity, the runtime client can change behind `DeepSeekHarnessAdapter` without affecting
orchestration or clients.

## Upstream references

- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek CLI and profile behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [ACP contract and limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
- [SDK protocol and limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [Web Host API contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/README.md)
- [Initial supported release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2)

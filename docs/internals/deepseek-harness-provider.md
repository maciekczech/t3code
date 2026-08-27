# DeepSeek Harness provider

> For maintainers. This document defines the first-party DeepSeek Harness integration boundary.

## Decision

T3 Code integrates DeepSeek Harness as a built-in provider driver named `deepseekHarness`. The
driver owns a scoped local `dsh web` process and talks to its loopback Web Host API. It translates
DeepSeek's durable session events into T3's canonical provider runtime events.

The integration does not use DeepSeek's ACP adapter. T3's existing `apps/server/src/provider/acp/`
transport makes ACP mechanically cheap to start, but it cannot restore the missing product
semantics. DeepSeek ACP intentionally omits live reasoning, tool activity, plans, token usage,
history, and session resume. The SDK JSON-RPC adapter exposes the
durable event stream, but it does not expose approvals, cancellation, session close, or a
prompt-completion boundary. The Web Host API is the only shipped out-of-process surface that
already combines the lifecycle and interaction features required by a first-class T3 provider.

DeepSeek Harness is a developer preview. The initial compatibility target is exactly
`dsh-v0.1.1-rc.2`. T3 must reject an unverified version with an actionable provider diagnostic
instead of attempting to interpret an unknown wire format. The allowlist and a boot-time behavior
probe are both required because the Web Host API deliberately has no protocol-version field.

## Compatibility baseline

The `dsh-v0.1.1-rc.2` compatibility contract includes:

- Node 22.19.x or 24 and newer, `dsh web --host 127.0.0.1 --port 0 --no-open`, the emitted
  `dsh web: http://...` readiness line, and ephemeral-port binding;
- HTTP JSON request/response envelopes plus WebSocket downlinks at `/api/events.mux` and
  `/api/events.host` (production is not an SSE transport);
- session creation, model discovery and selection, prompt admission, cancellation, history, and
  sequence-bearing durable events;
- streamed reasoning and text, tool-call arguments, tool completion, token usage, title and status
  projections, approvals, and structured questions;
- approval and question responses through `/api/respond` using the original server-request id;
- reconnect replay of a still-pending interaction while the same host process remains alive; and
- restart behavior: durable history survives and the interrupted turn closes with
  `turn/end(kind: interrupted)`, but a pending question is not durable and is not replayed.

## Product contract

DeepSeek Harness appears in the same provider-instance setup used by Codex, Claude, Cursor, Grok,
and OpenCode. A configured instance must support:

- installation, version, model, and update status in the existing provider UI; the status probe
  reports whether `DEEPSEEK_API_KEY` is configured, while the first prompt validates its value;
- new sessions, multiple turns, persisted history, and continuation after a T3 server restart;
- streamed assistant text, reasoning, tool calls and results, plans, and token usage;
- one-shot approvals, structured user questions, turn interruption, and session stop;
- image prompts on models that accept DeepSeek's Web Host image content;
- T3's per-thread permission and plan modes, with the provider-specific fallbacks documented below;
- isolated provider instances with distinct environment and DeepSeek home directories;
- web, desktop, and mobile clients without a client-to-DeepSeek connection; and
- local, relay, and tunnel connections without embedding a loopback origin in a client bundle.

Provider-side destructive rollback is not part of the initial contract because DeepSeek exposes
forking rather than history truncation. `rollbackThread` fails explicitly, as Grok's adapter does,
while T3 workspace checkpoint restoration remains available independently. DeepSeek-native
session forking, queue editing, goals, jobs, and provider settings are not exposed until T3 has a
matching product-level contract.

T3's optional agent-browser MCP bridge is a release-gated workstream, not an accidental omission.
DeepSeek's shipped MCP client is configured at the host/plugin level, while T3 issues a distinct
credential scoped to each thread. A shared DeepSeek host cannot safely install one static MCP
connection without leaking one thread's authority to other sessions. The implementation must
either add a small session-aware DeepSeek companion plugin or obtain an upstream per-session MCP
injection seam. The provider may be developed and tested without that bridge, but it is not
advertised as feature-parity complete until this gate is resolved and tested.

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

The first-class surface inventory is explicit so the provider cannot exist only on desktop/web:

- `packages/contracts/src/model.ts`, `settings.ts`, and the text-generation provider vocabulary;
- the built-in driver and adapter registries plus provider maintenance/status cases;
- web session logic, provider metadata, model selection, and provider icon mapping;
- the mobile provider icon and provider-selection presentation;
- the shared web/desktop settings form and diagnostics; and
- `docs/user/` installation, provider, permission-mode, and limitation guidance.

Desktop wraps the web surface and needs no provider-specific IPC. Any additional exhaustive switch
found by typechecking is part of the same surface work, not optional cleanup.

## Components

### `DeepSeekHarnessDriver`

The driver kind is `deepseekHarness`, with multiple instances allowed. Its settings are:

| Field        | Default | Meaning                                                                     |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `enabled`    | `false` | Existing hidden provider-instance switch; preview users opt in.             |
| `binaryPath` | `dsh`   | DeepSeek Harness executable.                                                |
| `homePath`   | empty   | Optional `DSH_HOME`; an empty value uses an instance-isolated T3 directory. |
| `launchArgs` | empty   | Additional arguments appended after T3-owned Web flags.                     |

Credentials remain environment variables, primarily `DEEPSEEK_API_KEY`, managed through the
existing per-instance environment editor. Secrets are never copied into settings, logs, command
arguments, or provider snapshots.

The provider snapshot reports DeepSeek's Node prerequisite (`^22.19.0 || >=24.0.0`) separately
from executable installation so an old Node runtime does not look like an authentication failure.

`launchArgs` uses the repository's existing shell-argument parser. It rejects `--host`, `--port`,
and browser-opening flags because the runtime owns those values and must remain loopback-only.

The driver creates one runtime, adapter, text-generation service, and managed provider snapshot per
instance. The MVP text-generation service fails explicitly with an actionable unsupported error;
it does not start a duplicate host or consume events from the conversation adapter's single-consumer
queue. A later implementation must share a broadcast-capable host runtime and archive scratch
sessions before this provider is offered for commit, branch, pull-request, or fallback-title text.

### `DeepSeekHarnessRuntime`

The runtime follows `OpenCodeRuntime`:

1. Resolve the configured executable using the shared shell utilities.
2. run `dsh --version` and accept only the tested version;
3. create or reuse the instance's private `DSH_HOME`;
4. spawn `dsh web --host 127.0.0.1 --port 0 --no-open` with the merged instance environment;
5. parse the canonical `dsh web: http://127.0.0.1:<port>` readiness line;
6. complete a health query before reporting readiness; the adapter then establishes both WebSocket
   downlinks before it creates or resumes a T3 session; and
7. bind graceful termination and forced cleanup to the provider-instance scope.

The runtime is shared by all sessions belonging to that provider instance. It may connect to
loopback only. T3 clients continue to communicate solely with the T3 server.

The child inherits the server process environment, matching the existing provider drivers, then
applies the provider-instance environment overlay and an instance-scoped `DSH_HOME`. T3 disables
browser opening through the command line and never places prompt or credential values in arguments.

Termination reuses the repository's managed-child semantics: signal the recorded process group on
POSIX, use the existing Windows process-tree path on `win32`, bound graceful shutdown, and force
only the recorded child tree. No name- or path-based killing is permitted.

### `DeepSeekHostClient`

This module is a narrow client for the subset of the Web Host API T3 uses:

- `session.list`, `session.create`, `session.history`, `session.models`,
  `session.selectModel`, `session.prompt`, and `session.cancel`;
- the generic `commands/execute` route used for session permission and plan switches;
- the session mux and host-status WebSocket streams; and
- the response channel for approvals and structured questions.

Wire envelopes and every consumed event are decoded at the boundary with Effect Schema. The client
does not depend on DeepSeek's host package at runtime: that package pulls most of the Harness plugin
graph into T3 and would couple two application runtimes. Unknown optional fields are ignored and
unknown session event discriminants are skipped. A malformed known event or envelope is a protocol
error and makes the affected session fail visibly.

The client owns request identifiers and stream cancellation. The adapter deduplicates live events
by DeepSeek sequence and reloads history on persisted-session resume. Automatic in-process stream
reconnect with `beforeSeq` gap repair remains a release gate. DeepSeek's current `since` stream
parameter is not relied on because it is documented as unimplemented.

### `DeepSeekHarnessAdapter`

The adapter keeps a T3-thread-to-DeepSeek-session table. A table entry contains the DeepSeek
session id, cwd, last accepted sequence, reconstructed turn snapshots, pending interactions, and
current activity state.

After session creation and before admitting a turn, the adapter applies T3 state through
DeepSeek's host `commands/execute` route. Permission presets map as follows:

| T3 runtime mode     | DeepSeek preset      | Contract                                                                                                                                                                                     |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-required` | `read-only`          | Safest approximation: writes require a model-requested escalation and approval, but harmless read-only commands may run without a prompt.                                                    |
| `auto-accept-edits` | `workspace-write`    | Approximation: workspace edits and workspace-confined commands run; escalation outside the workspace still asks. DeepSeek cannot separately auto-allow edits while asking for every command. |
| `auto`              | `workspace-write`    | Native match for routine in-workspace work with risky escalation prompts.                                                                                                                    |
| `full-access`       | `danger-full-access` | Native match: unrestricted sandbox and approval policy `never`.                                                                                                                              |

The clients retain T3's shared permission-mode vocabulary; this table is the provider-specific
source of truth for the two approximations. If a future DeepSeek release exposes per-tool policy,
the compatibility layer may tighten these mappings without changing T3's contract.

T3's `default` interaction mode executes `/plan off` when the DeepSeek projection is active;
T3's `plan` interaction mode executes `/plan` when it is inactive. The adapter waits for the plan
projection or command completion before prompting, so a mode change cannot race the turn.

- `startSession` creates a DeepSeek session for a new thread or attaches to the persisted session
  named by the continuation identity.
- `sendTurn` applies the requested runtime and interaction modes, selects the requested model and
  reasoning effort, submits ordered text/image content, and returns after admission. Completion is
  driven by the event stream.
- `interruptTurn` calls `session.cancel` and waits for the corresponding turn end or idle boundary.
- `respondToRequest` and `respondToUserInput` echo the original DeepSeek server-request id.
- `stopSession` cancels active work, waits for quiescence, and detaches T3 state without deleting
  DeepSeek history. The shared process remains alive while the provider instance exists.
- `readThread` returns the adapter's reconstructed snapshots.
- `rollbackThread` reports that DeepSeek Harness does not support provider-side rollback.

`llm.models` is authoritative for the provider snapshot, while `session.selectModel` applies the
chosen provider, model, and effort to a session. In the tested release all three shipped
DeepSeek models expose reasoning efforts `off`, `low`, `high`, and `max` with `high` as the default;
T3 presents these through its existing model-option selector and sends the selected effort through
`session.selectModel`. No hard-coded assumption prevents another configured DeepSeek Harness model
provider from contributing its own catalog or effort vocabulary.

On startup, `listSessions` and history are used only for sessions T3 already owns. The adapter never
imports unrelated sessions from a user's standalone DeepSeek Web profile.

### Provider snapshot and maintenance

The provider probe reports separately:

- executable missing;
- executable present but version unsupported;
- Web runtime startup or protocol failure;
- available models and their reported reasoning options.

The snapshot uses DeepSeek's model directory instead of hard-coding it. Alongside the catalog, the
probe calls `credentials.describe` for `DEEPSEEK_API_KEY`. That privileged loopback method returns
only whether the reference is configured, its source, and whether it is writable; it never returns
the secret. A configured reference is labeled **API key configured**, while a missing reference is
an actionable unauthenticated state. DeepSeek still validates the key itself on the first prompt,
and T3 maps missing or rejected-key errors to provider-specific guidance. The probe does not spend
a model request or claim that a configured key has been accepted by DeepSeek.

Maintenance identifies the npm package `@deepseek-ai/dsh`, but the first release uses T3's existing
manual-only maintenance capability. The current package-manager helpers always install `@latest`,
which conflicts with an exact protocol allowlist. T3 may show the latest registry version as an
advisory, but it does not offer one-click update until the helper can install an explicitly approved
version. Adding that generic pinned-install capability is a separate, tested maintenance change;
the provider adapter does not smuggle a custom updater into its runtime.

## Event translation

The translation layer covers the MVP subset of the tested DeepSeek event vocabulary and preserves
the native payload on every translated canonical event.

| DeepSeek event                | T3 event                                                |
| ----------------------------- | ------------------------------------------------------- |
| session attach/create         | session and thread started/configured                   |
| `turn/start`                  | turn started                                            |
| `turn/end`                    | turn completed or aborted from its reason               |
| assistant reasoning chunks    | reasoning item lifecycle and deltas                     |
| assistant text/image chunks   | assistant item lifecycle and deltas                     |
| `tool/call`                   | tool item started                                       |
| `tool/result`                 | tool item completed, including error metadata           |
| `todo/write`                  | turn plan updated                                       |
| assistant usage               | thread token usage updated                              |
| title event/projection        | thread metadata title updated                           |
| host session status           | session activity state changed                          |
| approval requested/resolved   | request opened/resolved                                 |
| question requested/resolved   | user input requested/resolved                           |
| subagent start/progress/end   | target: task lifecycle events; not projected by the MVP |
| host agent error/process exit | session error and exit                                  |

Tool-call argument deltas update the in-progress tool item; DeepSeek does not emit a distinct
long-running tool-progress vocabulary in the tested fixture, so T3 emits no fabricated percentage
or status messages between call and result. `turn.diff.updated` remains owned by T3's checkpoint and
git-diff pipeline rather than the provider. DeepSeek title projections map to
`thread.metadata.updated`; host running/idle changes map to `session.state.changed`.

Live events pass through the pure translator. Resume history currently groups the validated native
events into turn snapshots and establishes the last accepted sequence without re-emitting old
canonical events. Rebuilding the translator's richer item and projection state from that replay is
required before automatic reconnect is enabled.

## Session and data flow

For a new thread, T3 starts or reuses the instance runtime, creates a DeepSeek session at the
project cwd, applies the selected model, stores the returned session id as provider continuation
metadata, and subscribes before the first prompt. DeepSeek persists its own native log under the
instance home; T3 persists the canonical projection it already owns.

For continuation, T3 starts the runtime, finds the exact stored DeepSeek session, loads its history,
reconstructs the native turn snapshots and sequence baseline, then sends the next prompt. If the
native session is missing, continuation fails visibly rather than silently creating a blank conversation. Cwd
comparison uses the same lexical-then-realpath equivalence as OpenCode so symlink and `/tmp` aliases
do not cause false mismatches. A genuinely relocated workspace fails with a recovery action to
start a new DeepSeek session; the adapter never attaches history to a different directory silently.

An event is acknowledged into adapter state only after schema validation and sequence checking.
T3's ordinary ingestion worker then turns it into persisted orchestration state. Approval and
question requests keep their DeepSeek request id in memory so the existing T3 response commands can
answer the correct pending promise. Submitted question answers remain attached to that request
until DeepSeek emits `question/resolved`, so the canonical resolved event contains the actual
answer. The current wire supports only one-time approval; longer-lived approval choices are
rejected rather than silently weakened.

## Failure and recovery

- Startup has a bounded readiness timeout and includes sanitized stderr in diagnostics.
- Unexpected child exit or either WebSocket failure fails active turns, resolves in-memory pending
  interactions as unavailable, emits a session error, and does not respawn during that failure.
- A later adapter operation may start one fresh scoped host. Mode projections are reset before a
  resumed native session is used, so permissions and plan state are applied again. Repeated crashes
  remain visible and do not form a background restart loop.
- Automatic stream reconnect and history gap repair are not in the MVP. A stream loss is a visible
  session failure; a later operation can restart the host, but it does not claim the failed turn
  continued seamlessly.
- A DeepSeek host restart cannot restore an in-memory pending question or approval. T3 resolves the
  stale control and the user retries the turn if needed.
- Duplicate live events are ignored by native sequence. Resume history establishes the sequence
  baseline before new events are accepted.
- Turn interruption sends `session.cancel` and waits up to five seconds for `turn/end` or the host's
  idle boundary. Session stop uses the same boundary before it detaches and emits `session.exited`;
  a timeout is reported instead of claiming the host has stopped. Scope closure and server shutdown
  terminate only the recorded child process.
- Secret values and prompt content are excluded from ordinary diagnostics. Translated canonical
  events retain their native payload for ingestion diagnostics; a separate native NDJSON logger is
  not wired in the MVP.

## Compatibility and remote behavior

The DeepSeek process is an implementation detail of the T3 server. Browser, desktop, and mobile
clients receive only canonical T3 contracts, so relay and tunnel behavior match other providers and
no DeepSeek port is reachable remotely. Multiple T3 devices can observe and answer the same pending
interaction through T3's existing event-sourced orchestration.

Compatibility is established by executable version plus a boot-time behavior probe, not version
text alone. The focused compatibility fixture must cover create, prompt, streamed reasoning, tool
events, approval, question, cancellation, history replay, and process shutdown. Supporting another
DeepSeek release means adding it to the tested range only after that fixture passes.

An unknown version is a hard compatibility failure even if the small boot probe succeeds: the probe
cannot exhaustively prove an unversioned event vocabulary. A known version that fails the probe is
also rejected. This two-key gate favors a clear unavailable provider over plausible but corrupt
conversation history.

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
- [Permission presets](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/README.md)
- [MCP client bridge](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [npm package and Node requirement](https://www.npmjs.com/package/@deepseek-ai/dsh)
- [Initial supported release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2)

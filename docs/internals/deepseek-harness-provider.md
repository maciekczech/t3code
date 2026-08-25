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

## Verified upstream baseline

This design was checked against the published `dsh-v0.1.1-rc.2` package and tag on 2026-08-25.
At that point both npm `latest` and `next` resolved to `0.1.1-rc.2`, and the tag resolved to commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

A local compatibility spike used the real `dsh` executable and Web Host with a deterministic mock
DeepSeek model endpoint. It verified:

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

The spike resolves the earlier uncertainty about approvals, reasoning, and usage: all three are on
the tested Web Host wire. It also establishes a compatibility fixture to preserve during
implementation rather than asking T3's translator to trust documentation alone.

### Review disposition

| Review concern | Resolution |
| --- | --- |
| Approvals, reasoning, and usage may be absent | Verified on the real Web Host wire; retain them in the product contract. |
| Pending interactions across restart | Confirmed lossy; fail the stale T3 request and expose retry. |
| Version/tag and startup flags | `0.1.1-rc.2`, ephemeral port, host binding, no-open, and readiness output verified. |
| Runtime permission modes | Added an explicit four-mode mapping with two labeled approximations. |
| Model options | Reasoning efforts are supported and come from `session.models`. |
| Missing client surfaces | Added the contracts, web, desktop, mobile, settings, diagnostics, and docs inventory. |
| Update pin conflicts with `@latest` helper | Initial maintenance is manual-only; pinned generic updates are separate work. |
| Text-generation session growth | Fresh scratch sessions are archived; retained native logs are documented. |
| MCP bridging | Made a release gate because T3 credentials are per-thread and a static shared-host bridge is unsafe. |
| Windows teardown and cwd aliases | Reuse existing process-tree and realpath-equivalence precedents. |
| ACP might be a cheap v0 | Rejected explicitly because T3's ACP transport cannot replace missing DeepSeek semantics. |

## Product contract

DeepSeek Harness appears in the same provider-instance setup used by Codex, Claude, Cursor, Grok,
and OpenCode. A configured instance must support:

- installation, authentication, version, model, and update status in the existing provider UI;
- new sessions, multiple turns, persisted history, and continuation after a T3 server restart;
- streamed assistant text, reasoning, tool calls and results, plans, and token usage;
- one-shot approvals, structured user questions, turn interruption, and session stop;
- images when the selected DeepSeek model advertises image input;
- subagent activity when DeepSeek emits durable subagent events;
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

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Existing hidden provider-instance switch. |
| `binaryPath` | `dsh` | DeepSeek Harness executable. |
| `homePath` | empty | Optional `DSH_HOME`; an empty value uses an instance-isolated T3 directory. |
| `launchArgs` | empty | Additional arguments appended after T3-owned Web flags. |

Credentials remain environment variables, primarily `DEEPSEEK_API_KEY`, managed through the
existing per-instance environment editor. Secrets are never copied into settings, logs, command
arguments, or provider snapshots.

The provider snapshot reports DeepSeek's Node prerequisite (`^22.19.0 || >=24.0.0`) separately
from executable installation so an old Node runtime does not look like an authentication failure.

`launchArgs` uses the repository's existing shell-argument parser. It rejects `--host`, `--port`,
and browser-opening flags because the runtime owns those values and must remain loopback-only.

The driver creates one runtime, adapter, text-generation service, and managed provider snapshot per
instance. Text generation uses a scratch DeepSeek session through the same runtime rather than a
second process or a duplicate direct-API client. Each request gets a fresh session, collects only
its terminal assistant text, and archives the session immediately. DeepSeek has no session-delete
method in the tested wire, so the native log remains under the instance home and follows the same
retention policy as other DeepSeek history. This limitation is visible in diagnostics and avoids
pretending that archiving is disk cleanup.

### `DeepSeekHarnessRuntime`

The runtime follows `OpenCodeRuntime`:

1. Resolve the configured executable using the shared shell utilities.
2. run `dsh --version` and accept only the tested version;
3. create or reuse the instance's private `DSH_HOME`;
4. spawn `dsh web --host 127.0.0.1 --port 0 --no-open` with the merged instance environment;
5. parse the canonical `dsh web: http://127.0.0.1:<port>` readiness line;
6. establish both WebSocket downlinks and complete a health query before reporting readiness; and
7. bind graceful termination and forced cleanup to the provider-instance scope.

The runtime is shared by all sessions belonging to that provider instance. It may connect to
loopback only. T3 clients continue to communicate solely with the T3 server.

The child receives a scrubbed, explicit environment. T3 supplies `DSH_HOME`, preserves sanctioned
provider-instance variables, disables browser opening through the command line, and does not expose
T3 pairing credentials to the child.

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
must not depend on DeepSeek's host package at runtime: that package pulls most of the Harness plugin
graph into T3 and would couple two application runtimes. Unknown optional fields are ignored;
unknown event discriminants are logged and skipped. A malformed known event or envelope is a
protocol error and makes the affected session fail visibly.

The client owns request identifiers, reconnection, and stream cancellation. Reconnection opens new
streams, requests fresh history pages using `beforeSeq`, repairs forward from the last accepted
sequence, and deduplicates by DeepSeek session id plus event sequence. DeepSeek's current `since`
stream parameter is not relied on because it is documented as unimplemented.

### `DeepSeekHarnessAdapter`

The adapter keeps a T3-thread-to-DeepSeek-session table. A table entry contains the DeepSeek
session id, cwd, last accepted sequence, reconstructed turn snapshots, pending interactions, and
current activity state.

After session creation and before admitting a turn, the adapter applies T3 state through
DeepSeek's host `commands/execute` route. Permission presets map as follows:

| T3 runtime mode | DeepSeek preset | Contract |
| --- | --- | --- |
| `approval-required` | `read-only` | Safest approximation: writes require a model-requested escalation and approval, but harmless read-only commands may run without a prompt. |
| `auto-accept-edits` | `workspace-write` | Approximation: workspace edits and workspace-confined commands run; escalation outside the workspace still asks. DeepSeek cannot separately auto-allow edits while asking for every command. |
| `auto` | `workspace-write` | Native match for routine in-workspace work with risky escalation prompts. |
| `full-access` | `danger-full-access` | Native match: unrestricted sandbox and approval policy `never`. |

The web and mobile permission-mode descriptions must show the two DeepSeek-specific approximations
when this provider is selected. Silently treating all non-full modes alike is rejected. If a future
DeepSeek release exposes per-tool policy, the compatibility layer may tighten these mappings
without changing T3's contract.

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

`session.models` is authoritative for model options. In the tested release all three shipped
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
- missing or rejected API credentials; and
- available models and their input/context capabilities.

The snapshot uses DeepSeek's model directory instead of hard-coding it. If discovery is unavailable
before authentication, the provider shows no runnable models and explains the credential or
discovery failure.

Maintenance identifies the npm package `@deepseek-ai/dsh`, but the first release uses T3's existing
manual-only maintenance capability. The current package-manager helpers always install `@latest`,
which conflicts with an exact protocol allowlist. T3 may show the latest registry version as an
advisory, but it does not offer one-click update until the helper can install an explicitly approved
version. Adding that generic pinned-install capability is a separate, tested maintenance change;
the provider adapter does not smuggle a custom updater into its runtime.

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
| title event/projection | thread metadata title updated |
| host session status | session activity state changed |
| approval requested/resolved | request opened/resolved |
| question requested/resolved | user input requested/resolved |
| subagent start/progress/end | task lifecycle events |
| host agent error/process exit | session error and exit |

Tool-call argument deltas update the in-progress tool item; DeepSeek does not emit a distinct
long-running tool-progress vocabulary in the tested fixture, so T3 emits no fabricated percentage
or status messages between call and result. `turn.diff.updated` remains owned by T3's checkpoint and
git-diff pipeline rather than the provider. DeepSeek title projections map to
`thread.metadata.updated`; host running/idle changes map to `session.state.changed`.

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
is missing, continuation fails visibly rather than silently creating a blank conversation. Cwd
comparison uses the same lexical-then-realpath equivalence as OpenCode so symlink and `/tmp` aliases
do not cause false mismatches. A genuinely relocated workspace fails with a recovery action to
start a new DeepSeek session; the adapter never attaches history to a different directory silently.

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
- A client reconnect to the same live DeepSeek host replays its pending interaction with a fresh
  request id. A DeepSeek host restart cannot do so: the durable turn is closed as interrupted and
  the pending question/approval is failed in T3 with a retry action. T3 never displays a stale
  approval control after restart.
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

An unknown version is a hard compatibility failure even if the small boot probe succeeds: the probe
cannot exhaustively prove an unversioned event vocabulary. A known version that fails the probe is
also rejected. This two-key gate favors a clear unavailable provider over plausible but corrupt
conversation history.

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
- all four T3 runtime-mode mappings, default/plan transitions, models, and reasoning efforts;
- interruption, disconnect recovery, session stop, and multi-instance isolation; and
- subprocess teardown on POSIX and Windows without killing unrelated processes; and
- scratch text generation, archive-on-success/failure, and concurrent-request isolation.

One opt-in compatibility test runs against the supported `dsh` release with a mock model transport,
so it exercises the real CLI, HTTP requests, WebSocket streams, approval/question responses, and
restart semantics without spending an API key. Existing provider registry, settings,
orchestration-ingestion, and maintenance tests gain a `deepseekHarness` case. Integrated
verification covers provider setup and a full conversation in web, confirms the Electron-packaged
server can find and launch `dsh`, and gives mobile a focused provider-selection, permission-mode,
approval/question, and conversation pass through the same server.

## Rollout

Delivery is split into gates while retaining one end-to-end target:

1. Land the protocol client, real-CLI compatibility fixture, runtime, and pure event translator.
2. Land the driver, adapter, runtime/plan modes, model options, interactions, continuation, text
   generation, maintenance snapshot, and every web/mobile/desktop presentation seam.
3. Resolve per-thread T3 MCP injection with an upstream seam or a narrowly versioned companion
   plugin. Its acceptance test proves two simultaneous DeepSeek sessions receive only their own
   T3 credential and invocation context.
4. Run the cross-surface and remote-mode matrix, document the shipped limitations, and enable the
   provider by default.

The first public release is first-class and compatibility-gated. The provider is selectable
whenever its driver is present; missing or incompatible installations render an actionable
unavailable state. There is no hidden generic-ACP fallback because that would silently remove core
features. If the MCP gate cannot be implemented safely against the supported release, the decision
returns to maintainers before public enablement rather than shipping cross-thread authority or
claiming full parity.

## Effort and difficulty

This is high-difficulty adapter work but does not require an orchestration rewrite. For one engineer
working with a coding agent, the planning estimate is:

| Workstream | Focused engineering time |
| --- | --- |
| Protocol client, runtime, compatibility fixture, translator | 5-8 days |
| Adapter behavior, interactions, modes, continuation, text generation | 5-8 days |
| Contracts, provider setup, web/mobile presentation, docs | 3-5 days |
| MCP isolation gate | 3-7 days if a companion plugin is viable; longer if upstream changes are required |
| Cross-platform, remote, regression, and review hardening | 3-5 days |

The realistic solo elapsed range is three to five weeks, with MCP/upstream uncertainty as the
critical path. A useful internal build without MCP can exist earlier, but calling it a fully
first-class public provider before the isolation and cross-surface gates pass would overstate it.

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

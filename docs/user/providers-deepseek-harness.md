# DeepSeek Harness

DeepSeek Harness support is a developer preview. It runs the Harness on the same machine as the
T3 Code server and makes it available in the normal provider and model pickers on web, desktop,
and mobile.

## Install

The preview supports exactly DeepSeek Harness `0.1.1-rc.2` and requires Node.js `^22.19` or 24
and newer. Node.js 23 is not supported by the Harness.
Install the tested version on the machine running T3 Code:

```bash
npm install --global @deepseek-ai/dsh@0.1.1-rc.2
dsh --version
```

The version command must print `0.1.1-rc.2`. T3 Code blocks other versions because the Harness
Web Host API is not versioned independently from its executable.

## Configure

1. Open **Settings** and add a **DeepSeek Harness** provider.
2. Add `DEEPSEEK_API_KEY` under that provider's environment variables and mark it sensitive.
3. Enable the provider and refresh its status.
4. Choose one of the discovered models when starting a thread.

The provider status says **API key configured** when the Harness can see the credential reference.
The key itself never comes back through the Harness status API. DeepSeek validates it on the first
prompt; if it is rejected, replace the value on this provider instance and retry.

Leave **Binary path** as `dsh` when the executable is on the server's `PATH`. Set an absolute path
when T3 Code is launched by a desktop app, service, or version manager that has a different path.

Leave **DSH_HOME path** empty for the recommended setup. T3 Code then gives each provider instance
an isolated Harness home. Set it only when you intentionally want T3 Code to reuse an existing
Harness profile.

## What The Preview Supports

- new and resumed multi-turn sessions
- streamed text and reasoning
- tool calls and results
- token usage and automatic thread titles
- approvals, structured questions, cancellation, and session stop
- model switching, model-provided reasoning efforts, and image attachments
- Supervised, Auto-accept edits, Auto, Full access, and plan mode
- local, relay, and tunnel clients through the T3 Code server

DeepSeek Harness runs on loopback and is never exposed directly to a remote browser or phone.

## Current Limits

- Provider-side rollback is unavailable. T3 Code workspace checkpoint restore still works.
- Sending another message while a turn is running is unavailable; interrupt or wait for it first.
- Commit messages, branch names, pull request text, and fallback thread-title generation cannot use
  this provider yet. DeepSeek's own session-title events still update conversation titles.
- DeepSeek-native subagent, job, and goal events are not projected into T3 Code yet. Todo snapshots
  do appear as the current turn plan.
- T3's per-thread browser/MCP tools are not injected into the shared Harness host yet.
- A pending approval or question does not survive a Harness host restart. Durable conversation
  history does survive and the interrupted turn is closed visibly.
- Updates are manual while T3 Code pins the tested version. Do not update this provider to npm
  `latest` until T3 Code lists that release as supported.

The status probe discovers the model catalog and checks whether `DEEPSEEK_API_KEY` is configured,
but it does not spend a model request to validate the value. An invalid key therefore appears when
the first prompt runs. Confirm that the key is attached to the correct DeepSeek provider instance,
then run `dsh web` in a terminal using the same environment to inspect Harness configuration errors.

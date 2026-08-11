# Disable Server Update Until Connected

## Problem

A saved remote environment can retain version and self-update metadata while its connection is
still connecting or reconnecting. The web UI therefore renders an enabled one-click **Update** or
**Retry** action before RPC is available, and selecting it produces an error toast.

## Design

`ServerUpdateAction` will derive the environment's current connection phase from the existing
reactive environment presentation. For self-updating servers, its button will be disabled unless
the phase is exactly `connected`. The click handler will apply the same guard before starting the
shared update command.

Because Settings, the chat update notice, the locally served web app, the hosted web app, and the
desktop Electron shell all use this component, the behavior will remain consistent across every
web entry point and host. The manual **Copy update command** action will remain available while
disconnected because it does not call the unavailable server. Desktop-managed guidance is text and
needs no change. Mobile has no server-update action UI.

The connection phase is already backed by a subscribed atom. A transition from `connecting` or
`reconnecting` to `connected` recomputes the presentation and rerenders the action, so the button
unlocks without local state or reset logic.

## Related Pull Requests

A GitHub search across open and closed pull requests found no duplicate fix. The closest open work
does not add this connection guard:

- [#5598](https://github.com/pingdotgg/t3code/pull/5598) hides the update action for an explicitly
  disabled environment, but leaves it active while an enabled environment connects or reconnects;
- [#5983](https://github.com/pingdotgg/t3code/pull/5983) adds VM start and stop hooks around the
  connection controls without changing `ServerUpdateAction`;
- [#4904](https://github.com/pingdotgg/t3code/pull/4904) changes desktop-managed update guidance;
- [#5254](https://github.com/pingdotgg/t3code/pull/5254) distinguishes client-behind from
  server-behind version skew.

Merged update work such as [#5470](https://github.com/pingdotgg/t3code/pull/5470),
[#5404](https://github.com/pingdotgg/t3code/pull/5404),
[#4992](https://github.com/pingdotgg/t3code/pull/4992), and
[#4903](https://github.com/pingdotgg/t3code/pull/4903) handles progress and reconnection after an
update starts, not preventing an update request before the environment connects.

## Verification

Focused component tests will verify that a self-update action:

- renders disabled and does not invoke the update command while disconnected;
- renders enabled when the same environment presentation is connected;
- retains the existing success, interruption, and double-click behavior.

Run the focused web test file plus targeted web type checking or linting supported by the package.
Browser verification and before/after screenshots require explicit approval before opening a
browser, but the pull request must include them because this is a visible UI-state change.

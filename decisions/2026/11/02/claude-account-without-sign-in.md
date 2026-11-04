# A Claude account can be added without signing in

Superseded in part on 2026-11-04 by `decisions/2026/11/04/grandfather-stale-custom-agent-paths.md`: a custom path saved before strictness that is gone now falls back to PATH with a warning; a removed stored account now clears the task's account (follows the default) instead of pinning the one used.

## Context
Some setups start Claude through their own wrapper that owns the credentials and may later point the account folder at its own config dir. dev3 should let such a user create the account without completing a Claude login.

## Decision
Add account first asks with the standard `confirm()` dialog (Sign in / Cancel / for Claude "Add without signing in"); nothing is created until a choice is made. The sign-in is then started with `AccountLoginManager.start`, which only prepares the staged dir and puts the login in the `ready` phase: no executable lookup, no process, no `claude auth status`, no polling, for every CLI. `beginAccountLogin` is the only point that resolves the executable and spawns (the record stays `ready`, without a session key, until the viewer session is registered); Retry restarts and begins in one step. A ready login expires and is discarded like a running one, and cancel discards it.
"Add without signing in" (`addClaudeAccountWithoutLogin`, `AccountLoginManager.addWithoutSignIn`, `registerStagedClaudeAccount` in `src/bun/agent-accounts.ts`). It registers the staged dir as an ordinary managed account with no identity: no `claude auth status` probe and no duplicate check, because no identity is known. The staged marker is removed so the abandoned-sign-in sweep never deletes the dir, the default account does not change, and the modal shows the manual login command. The identity appears by itself after a later login, because `toAccount` reads `.claude.json` from the dir on every list.
A wrapper may replace the account folder with a symlink to its own config dir. A slot that is a link, or whose realpath leaves its parent (`isLinkedClaudeSlot`), is never scaffolded into, and removal (`removeAccountSlot`, also used by discard and the abandoned-login sweep) unlinks it instead of recursing; a real dir is removed recursively. Such a slot is provisioned with dev3's skills and settings at launch, like any `CLAUDE_CONFIG_DIR` outside the managed slots.
The registry entry carries `autoLabel`: `listAgentAccounts` replaces the placeholder "Account N" with the email once the identity appears; a manual rename clears the flag. A Claude account with no identity is left out of Auto routing (an explicit pick still works).
An account id read from stored task or pane state (`CommandOptions.accountFromStore`) that is no longer in the Claude registry falls back to the default account with a toast; an explicitly passed unknown id, and an existing account that cannot launch, still throw.
Selecting an account that cannot launch (unknown id, missing or dangling dir, managed account without `.claude.json`) throws instead of falling back to the system login, and a broken custom executable path throws instead of falling back to PATH.

## Risks
An account added without a sign-in can later sign in as an identity that another account already has; there is no duplicate check at that point.
Several unsigned accounts can coexist and look alike ("Account N") until a login runs in each. A linked slot whose target is deleted fails the launch with a clear error until the account is removed. On Windows a junction is recognised only through the realpath check (unverified).

## Alternatives considered
A CLI to register an arbitrary existing folder, stored as a symlink or in a sidecar file: more surface (a new command, path validation, de-duplication) for a case the sign-in modal already covers.

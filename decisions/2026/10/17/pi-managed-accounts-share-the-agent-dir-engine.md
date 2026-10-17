# Managed pi accounts share omp's agent-dir engine

## Context

Plain pi (`earendil-works/pi`) signs in to OAuth and API-key providers itself (`/login`), like omp, and users want the same multi-account model in Settings → Accounts: many pi accounts, each with whatever providers the user adds, picked per launch.

## Investigation

Verified against pi 1.3.0 (`dist/config.js`, `docs/configuration.md`, `docs/providers.md`) and live in a scratch agent dir:

- `PI_CODING_AGENT_DIR` moves pi's agent dir, exactly as for omp: `auth.json` (credentials) and `sessions/` live inside it.
- pi has **no** `login` subcommand. `pi /login` is not a command either: the argument went to the model as a prompt. `ctx.ui.setEditorText` is public extension API, so an extension can type `/login` into the editor for the user to submit.
- `auth.json` is documented user-facing format, `{ "<provider>": { "type": "oauth" | "api_key", … } }`, and `/login` writes it for both kinds. `pi auth check` also counts env keys and does not say where a key came from, so it cannot tell an account's sign-ins from the user's environment.
- After a successful `/login`, pi persists that provider's default model with `setModel(…, { persist: true })` into `settings.json` (`modes/interactive/interactive-mode.js`), writing in place through any symlink.
- `pi --list-models` prints a text table only; `models-store.json` caches catalogs fetched with the account's own keys.

## Decision

- omp's account code became one engine over `AgentDirAccountKind = "omp" | "pi"` in `src/bun/agent-accounts.ts` (`agentDirAccountDir`, `prepareAgentDirLogin`, `completeAgentDirLogin`, `getActiveAgentDirSessionEnv`, …). pi's registry is its own `pi-accounts.json`, its dirs `agent-accounts/pi/<id>/`.
- Sign-in runs `pi --no-session -e <dev3 home>/data/agent-hooks/pi-login.ts` (`src/shared/pi-login-extension.ts`) in the embedded terminal; the user presses Enter on the typed `/login` and picks any method and provider.
- Verification reads only the provider ids and `type` of the account's `auth.json` (`parsePiAuthLogins`); values are never read or stored.
- Private per account: `auth.json`, `sessions`, `models-store.json`, locks and logs. `settings.json` is **copied** at creation instead of linked, so `/login`'s new default model stays in the account.
- omp and pi read the same variable, and a tmux session keeps env set by an earlier launch in it, so once an account of either harness exists the system login actively unsets `PI_CODING_AGENT_DIR` for both.
- Live models: `src/bun/agent-dir-live-models.ts` parses each harness's listing, keeps the account's providers, and puts the harness's default (pi: `defaultProvider/defaultModel`) first.

## Risks

- `--list-models` is a human table; a layout change makes live models answer "unknown" (the picker falls back to presets), never a wrong list.
- A pi without `setEditorText` shows an empty editor; the modal text still says to type `/login`.
- An account's copied `settings.json` does not follow later changes to `~/.pi/agent/settings.json`.
- `/login` inside omp's account still writes omp's shared `config.yml`; not changed here.

## Alternatives considered

- **Copying omp's code for pi:** two engines to keep in step, and the cross-harness env leak would need fixing twice.
- **`pi /login` as the launch argument:** sends `/login` to the model.
- **`pi auth check` for verification:** counts env keys as the account's sign-ins.

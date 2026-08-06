# 179. Per-key merge for the `env` config field

## Context

Per-project environment variables must reach the standalone project terminal,
every task-scoped agent terminal, setup/dev/cleanup script, column agent, and
spawned agent pane. They can be set in Project Settings (`projects.json`),
`.dev3/config.json` (shared), and `.dev3/config.local.json` (machine-local), but
this field is not for secrets.

## Decision

`env` is the one field that merges PER KEY across all cascade layers (worktree
local > worktree repo > main local > main repo > projects.json). Implemented as
an explicit special case after the uniform loop in `applyConfigCascade`;
launch-time consumers use `resolveProjectEnv()`, which re-reads the files so
config edits apply on the next launch. Injection order in task sessions:
project env first, so `DEV3_*` lifecycle vars and per-agent-config `envVars`
always override it. The UI identifies whether the active storage is local-only
or committed, and warns that saving worktree repo config commits immediately.

## Risks

Provenance surfaces (`dev3 config show`, UI source badges) attribute `env` to
its highest-priority source even when the effective map mixes layers. Accepted:
per-key provenance would complicate three surfaces for marginal value. Values
remain plaintext in existing config storage, so the product must not present
this field as secret storage.

## Alternatives considered

Whole-field resolution like every other key: rejected — a repo config defining
one var would silently erase all UI-configured vars, defeating the "shared file
+ machine-local overrides + UI" use case. A separate dotenv file or `envFile`
pointer was left out of v1 because it duplicates the existing config cascade
and gitignore machinery. Keychain/encryption and a variable-name denylist were
also left out: storage remains unchanged, and cloning a repository already
trusts its committed configuration.

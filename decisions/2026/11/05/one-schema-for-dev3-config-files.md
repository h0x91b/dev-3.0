# One schema for `.dev3` config files

## Context

Every config field was declared four times: the `Dev3RepoConfig` interface, the `DEV3_REPO_CONFIG_KEYS` list, the cascade's `DEFAULTS` and command-bearing set, and a hand-written table in the `dev3-project-config` skill. Agents changed settings by editing JSON blind, nothing validated the files, and upcoming fields would multiply the drift.

## Decision

`src/shared/config-schema.ts` holds `CONFIG_FIELDS`, a typed registry built from small spec builders. The `Dev3RepoConfig` type is derived from it (the type of each field comes from its `type` spec only, so an enum cannot widen to `string`), and so are the key list, the cascade defaults, `COMMAND_BEARING_CONFIG_KEYS`, the skill's field table, the JSON Schema that `dev3 config schema --json` prints, and the Project Settings fallback controls (`SchemaConfigFields`). A field with no hand-built control is rendered generically at the end of its `section`; `ConfigForm`'s own controls carry `data-config-keys`, and a test fails if any field that is not `ui: "none"` has no control.

Files carry an optional `schemaVersion`; absent means 1. `migrateConfig` steps a file up in memory on every read (`readJsonFile` in `src/bun/repo-config.ts`). The disk is rewritten only by the next write, which stamps the new version. Saves keep `schemaVersion` and unknown keys, so an older dev3 no longer drops fields a newer one wrote. `dev3 config set` edits one member's text (`src/shared/config-file-edit.ts`) and falls back to a full re-stringify in the file's own indent only when the splice would not parse to the expected object.

`dev3 config show` now resolves through `resolveOperationalProjectConfig` and names four file layers (`local`, `repo`, `main-local`, `main-repo`), because the single-path view it used to print disagreed with what a task launch actually reads from inside a worktree.

## Risks

Generic controls show the config key and the schema's English description instead of translated text: they are file-format identifiers, and a field that deserves localized copy should get a bespoke control. A new field lands in the UI automatically; one that adds a notable control should still go through `/ux-principal`. Reading a migrated file costs one in-memory pass per read, which is nothing while `CONFIG_MIGRATIONS` is empty.

## Alternatives considered

A JSON Schema document as the source: no TypeScript types without codegen, and the cascade needs flags (`executes`, `mergePerKey`) JSON Schema has no slot for. A zod-style library: a new runtime dependency in the CLI bundle for what a few builders cover. Writing `schemaVersion` into every file on first save: churns committed configs for no reader that needs it yet.

# Artifact starter reachable through the CLI, not only through launch env

## Context

`DEV3_ARTIFACT_TEMPLATE_DIR` is exported by the generated launch script and set on the
tmux session at task launch (`ensureArtifactTemplateEnv`, `src/bun/artifact-template.ts`,
consumed in `src/bun/rpc-handlers/tmux-pty.ts`). Every agent launch path sets it, yet issue
#1437 reports tasks where it is absent while a sibling task on the same host has it.

## Investigation

The variable is baked into an environment at spawn time. Two states reproduce the report
without any launch path being buggy: a session started by an app version whose bundle had no
`artifact-template` (or before the feature shipped) keeps running with the old environment,
and a shell that never inherited the launch script's exports has no way to learn the path.
`ensureArtifactTemplateEnv` deliberately degrades to an empty env rather than blocking a
launch, so the failure is silent by design.

## Decision

Stop treating the launch environment as the only channel. `dev3 artifact-template`
(`src/cli/commands/artifact-template.ts` → `artifact.template-dir` in
`src/bun/cli-socket-server.ts`) provisions the starter from the bundle and copies it into
`./dev3-artifact-report` — the destination the artifact workflow already documents — so the
recovery is one command with no arguments to choose. Re-running it restores the managed files
over an existing copy. The skill text now sends agents here instead of stopping at "starter
provisioning failed".

## Risks

The command needs the app running, like every other socket-backed CLI command; a task whose
app is closed gets the standard exit 2 rather than a starter. Copying into a fixed directory
name means a report living somewhere else must be moved by hand — accepted, because a flag
for it is exactly the complexity this command exists to avoid.

## Alternatives considered

Printing the path and letting the caller `cp -R` was the first cut; it needed a `--copy-to`
flag and an offline fallback to be useful, which is more surface than the problem deserves.
Re-exporting the variable into running sessions was rejected because an already-running
process cannot have its environment rewritten. Making `ensureArtifactTemplateEnv` throw was
rejected too — a broken bundle would then block task launches over a feature most tasks never
use.

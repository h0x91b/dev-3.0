# 121 — Task-local artifact starter

## Context

Agents knew how to call `dev3 show-artifact`, but they had no reliable visual baseline or way to discover the product's theme tokens and branding. A single mutable template under `~/.dev3.0` would also be shared by side-by-side app versions and could be damaged by an agent editing it directly.

## Investigation

The app already bundles static resources for desktop and CLI/headless releases, while every task has a dev3-owned container outside the Git worktree. Agent launches are the common seam for new tasks, reopened tasks, extra panes, and bug-hunter panes, so provisioning there covers existing tasks lazily without a startup migration.

## Decision

The canonical v1 starter lives in `src/assets/artifact-template/` and ships in both Electrobun and CLI bundles. `artifact-template.ts` atomically restores its known files into the task container's versioned `artifact-template-v1/` directory before agent launch, preserves unknown files, and exports the absolute path as `DEV3_ARTIFACT_TEMPLATE_DIR`; the injected dev3 protocol tells agents to copy it into the worktree before editing.

## Risks

Different installed app versions can restore different v1 content when they launch the same task, but the directory remains app-owned and the v1 DOM/token contract stays compatible. Provisioning failure now blocks an agent launch instead of silently producing an unbranded artifact, making packaging regressions visible immediately.

## Alternatives considered

Rejected a single global mutable template because concurrent app versions and agents would share one damage-prone file. Rejected embedding a large HTML document and PNG as TypeScript/base64 because it obscures authoring and bloats compiled source; rejected copying into Git worktrees because the starter would pollute user diffs before it is requested.

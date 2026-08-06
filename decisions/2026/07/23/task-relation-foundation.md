# 148 — Task relation foundation

## 1. Context

Tasks need a durable place for future Jira-like links without introducing UI behavior or external synchronization yet. The first relation kinds are `blocked-by` and `relates-to`.

## 2. Investigation

Task state is stored as objects in `tasks.json`, and the data layer already preserves additive fields while performing content-only migrations. Existing task mutations use the same locked read-modify-write path, so a relation collection belongs on the task model rather than in a second store.

## 3. Decision

Represent links as optional `Task.relations`, with each entry containing a stable `taskId` and a `TaskRelationType`. New tasks initialize the collection and mutator reads backfill it to `[]`; no UI, CLI, RPC action, reverse-link materialization, or external integration is added yet.

## 4. Risks

Relation records can point at deleted or cross-project tasks until a future relation service adds validation and cleanup rules. Treating the field as optional keeps raw legacy files readable, and the compatibility regression test verifies an older-reader-shaped update preserves the additive key.

## 5. Alternatives considered

Separate `blockedBy` and `relatesTo` arrays were rejected because every future relation kind would require another schema field and migration. A separate relation file was rejected because it would add cross-file locking and lifecycle work before relation behavior exists.

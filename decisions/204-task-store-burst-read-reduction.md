# 204 — Decide the hourly tasks backup with stat(), not two full reads

## Context

The hourly backup read the store, then the existing backup. Once this hour's snapshot exists both are redundant; only the hour's first save needs that content.

## Investigation

The `perf:task-store` harness saw no stall above 16 ms, so the freezes reported were **not reproduced here**. Of the 221 MB ten mutations moved, ~148 MB was those two reads; 74 MB of mutator reads stays, blocking unchanged.

## Decision

`writeHourlyTasksBackup` answers "is this hour covered" with `stat()`, reads the store only when about to snapshot, and prunes only when it wrote one. The hour is captured before that read, so a boundary-spanning read stays in its start hour.

## Risks

Expired backups stay until the next snapshot is written, and a save crossing an hour boundary buckets an hour earlier. Every mutation still parses, stringifies and publishes the store; no cache or write path is touched.

## Alternatives considered

Serving mutators from cache was built twice and dropped: a cached value may only reach a writer if parsed from the published bytes, reinstating the parse and worsening the stall tail (see the task notes). Removing the per-mutation stringify and publish needs coalescing and a durability design.

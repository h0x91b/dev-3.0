# 114 — GA4 page paths use project id, never the project name

## Context

The app reports to a GA4 **web** data stream (measurement_id `G-L1NSQH6FGY`) via the
Measurement Protocol (`src/mainview/analytics.ts`). The marketing landing page
(`docs/index.html`) reports to the **same** property. We wanted human-readable page
paths (`/project/<x>/kanban`, `/task/<id>`, `/diff/<id>`) instead of the old flat
`app://dev3/<screen>`, and to tell app hits apart from landing-page hits.

## Update — page_location must be a real https URL

The first cut built `page_location` as `app://dev3<path>`. GA4 derives the **Page
path** dimension by parsing `page_location` as a URL, but only for `http(s)` — a
custom scheme leaves Page path "(not set)" (page_title, sent explicitly, still
arrived, which masked it). Fixed by emitting `https://dev3.local<path>`
(`APP_LOCATION_ORIGIN` in `analytics.ts`); the synthetic host stays distinct from
the landing host so the two remain separable. A regression test asserts
`new URL(page_location).protocol === "https:"`.

## Decision

`analyticsLocationForRoute(route, taskLabel?)` maps every `Route` to an
`/app`-prefixed path (`/app/project/<projectId>/kanban`,
`/app/project/<projectId>/task/<seq>`, `/app/project/<projectId>/diff/<seq>`,
`/app/dashboard`, `/app/settings`, …). The `/app` prefix separates the app from the
landing page in the shared property. The **project** segment is dev3's internal
random id (see below). The **task** segment is the human-readable per-project
sequence label from `taskSeqLabel(task)` (e.g. `981-1` = seq 981, variant 1) —
resolved by the caller from the loaded task list, falling back to the raw task id
only when the task isn't loaded yet. This lets us see how deep into a project's task
list users get. `taskSeqLabel` is the single source of truth for that format and is
also what `GlobalHeader` renders (with a leading `#`).

We deliberately do **not** send the project *name*. A repo/folder name is user
content that can be confidential (a client under NDA, an unreleased codename), and
GA4's terms forbid PII. The id gives us all product analytics (distinct projects,
per-project activity, retention) without ever exposing what a project is.

## Risks

We can't answer "which named company uses dev3" from analytics — accepted; that is
exactly the data we should not silently collect. Diff is not a route, so its page
view is fired explicitly on open from the two inline-diff consumers
(`ProjectView`, `TaskWorkspaceView`); a future third consumer must fire
`trackDiffView` itself.

## Alternatives considered

1. **Send the project name** — richest signal, but leaks confidential names, breaks
   the privacy policy, and is a one-way door (can't un-send). Rejected.
2. **Hash the name** — no privacy win over the id (still opaque) and adds code.
3. **Separate GA property for the app** — avoids the landing/app mix but is heavier
   than a path prefix and splits reporting; the `/app` prefix is enough.

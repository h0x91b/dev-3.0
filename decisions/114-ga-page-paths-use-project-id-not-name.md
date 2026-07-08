# 114 — GA4 page paths use project id, never the project name

## Context

The app reports to a GA4 **web** data stream (measurement_id `G-L1NSQH6FGY`) via the
Measurement Protocol (`src/mainview/analytics.ts`). The marketing landing page
(`docs/index.html`) reports to the **same** property. We wanted human-readable page
paths (`/project/<x>/kanban`, `/task/<id>`, `/diff/<id>`) instead of the old flat
`app://dev3/<screen>`, and to tell app hits apart from landing-page hits.

## Decision

`analyticsLocationForRoute(route)` maps every `Route` to an `/app`-prefixed path
built from the **internal project/task ids** (`/app/project/<projectId>/kanban`,
`/app/project/<projectId>/task/<taskId>`, `/app/project/<projectId>/diff/<taskId>`,
`/app/dashboard`, `/app/settings`, …). The `/app` prefix separates the app from the
landing page in the shared property; the ids are dev3's own random identifiers.

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

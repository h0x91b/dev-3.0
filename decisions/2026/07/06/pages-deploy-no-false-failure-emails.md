# 109 — GitHub Pages deploy: never email a false "Run failed"

## Context

The repo served its landing page (dev3.h0x91b.com) via legacy "Deploy from a
branch" Pages mode. GitHub auto-generates a hidden `pages-build-deployment`
workflow that fires on **every** push to `main`. On parallel PR merges two
deployments raced the Pages API and the superseded one died with
`Deployment failed, try again later.`, emailing a false "Run failed". That
auto-workflow lives in no file and cannot be given a path filter or concurrency
group, so it could not be fixed in place.

## Investigation

Migrated to a custom `.github/workflows/pages.yml` (path-filtered to `docs/**`,
`concurrency: pages`, `cancel-in-progress: false`) and flipped the repo Pages
`build_type` from `legacy` to `workflow`. That killed the parallel-merge races,
but a lone deploy with **no** concurrent run still failed once with the same
transient `Deployment failed, try again later.` — a GitHub Pages backend hiccup
(the action's own error text points at githubstatus.com and says "re-run
later"). A manual GitHub "Re-run" made it worse: re-runs re-upload the
`github-pages` artifact, so `actions/deploy-pages` then aborts with
`Multiple artifacts named "github-pages" ... Artifact count is 2.`

## Decision

`pages.yml` now retries `actions/deploy-pages` **once inside the same job**
(both attempts `continue-on-error: true`, a 60s cool-down between) and a final
`Summarize deploy result` step keeps the run green even if both attempts fail,
emitting only a `::warning::`. In-job retry self-heals the transient backend
error so no human ever needs the "Re-run" button (which triggers the
duplicate-artifact bug), and the never-fail policy guarantees no false
"Run failed" email. A landing page that keeps serving its previous version
until the next docs push is not worth a failure alert.

## Risks

A genuinely broken deploy (bad artifact, real Pages outage) is now silent
except for a warning in the Actions UI — acceptable for a static marketing
page, not for critical infra. If the site must hard-fail on deploy errors in
the future, drop the `continue-on-error` on the retry step.

## Alternatives considered

- Plain `continue-on-error` with no retry — never spams but leaves the site
  stale more often on transient blips.
- Narrowing the trigger to `docs/index.html` only — fewer runs, but a transient
  failure on a real landing-page change would still email.
- Disabling Actions failure emails at the account level — silences real
  build/release failures too. Rejected.

# Artifact template choice (dev3 / free-form / My template) reaches agents as a launch env var

## Context

#1848 asked to turn the dev3 artifact template off globally, per project, and per artifact. The protocol body is one static text shared by every task (and at its Windows size cap), so it cannot carry a per-project value. `decisions/2026/10/04/explicit-non-html-request-overrides-template.md` only covered an explicit request for Markdown or no HTML, not free-form HTML.

## Decision

`GlobalSettings.artifactTemplate` (`"off" | "custom"`, absent = the dev3 template) and `Project.artifactTemplate` (`"on" | "off" | "custom"`, absent = inherit), plus an optional `artifactTemplatePath` at both levels, resolve through `resolveArtifactTemplate` (`src/shared/types.ts`). `provisionArtifactStarter` (`src/bun/artifact-template.ts`) picks the starter: the bundled one, or for `custom` a fresh per-task copy of the user's folder (`artifact-template-custom/`, dotfiles and `CUSTOMIZE.md` skipped). The default folder `~/.dev3.0/artifact-template-custom` and any empty folder are seeded with a copy of the dev3 template, so customizing starts from something that works; a folder with files is never written. A configured folder that does not exist falls back to the dev3 template instead of being created at launch. `DEV3_ARTIFACT_TEMPLATE=off|custom` is added only off the default, so a default launch is unchanged. One bullet in `ARTIFACT_FORMAT_RULES` tells agents what each value means; for `custom` the user's `AUTHORING.md` is the contract. The injected fallback theme (`injectArtifactThemeContract`) now wraps every selector in `:where()`: it is inserted after the page's own `<style>`, so at normal specificity it overrode a free-form page's `html` background.

## Risks

The env is fixed at launch: a session started before the setting changed keeps the old value until it is relaunched or resumed. The per-artifact override is an agent judgement call on the user's wording. A seeded copy never receives later dev3 template updates; emptying the folder re-seeds it. In `custom` mode the stock dev3 starter is not provisioned, so "use the dev3 template for this one" has nothing to copy.

## Alternatives considered

- **Per-launch protocol text** — the body is one shared file per agent and already at the Codex Windows cap.
- **Withholding `DEV3_ARTIFACT_TEMPLATE_DIR` when off** — reads as a broken launch and makes the per-artifact "use the template" path need a recovery command.
- **Branding overrides on top of the dev3 shell (logo, eyebrow, token CSS)** — keeps template updates flowing but limits changes to what the shell exposes; the user chose full folder control.
- **Moving the injected theme to the top of `<head>`** — same effect for free-form pages, but `:where()` also keeps it from beating any later author rule.

# Artifact template opt-out reaches agents as a launch env var

## Context

#1848 asked to turn the dev3 artifact template off globally, per project, and per artifact. The protocol body is one static text shared by every task (and at its Windows size cap), so it cannot carry a per-project value. `decisions/2026/10/04/explicit-non-html-request-overrides-template.md` only covered an explicit request for Markdown or no HTML, not free-form HTML.

## Decision

`GlobalSettings.artifactTemplate` (`"off"` or absent) and `Project.artifactTemplate` (`"on" | "off"`, absent = inherit) resolve through `resolveArtifactTemplate` (`src/shared/types.ts`). `artifactTemplateModeEnv` (`src/bun/artifact-template.ts`) adds `DEV3_ARTIFACT_TEMPLATE=off` to the launch env only when the result is off, so a default launch is unchanged. The starter is still provisioned either way, so "use the template for this one" works. One bullet in `ARTIFACT_FORMAT_RULES` tells agents to read the variable or a per-artifact request; asking for the template wins. The injected fallback theme (`injectArtifactThemeContract`) now wraps every selector in `:where()`: it is inserted after the page's own `<style>`, so at normal specificity it overrode a free-form page's `html` background.

## Risks

The env is fixed at launch: a session started before the setting changed keeps the old value until it is relaunched or resumed. The per-artifact override is an agent judgement call on the user's wording.

## Alternatives considered

- **Per-launch protocol text** — the body is one shared file per agent and already at the Codex Windows cap.
- **Withholding `DEV3_ARTIFACT_TEMPLATE_DIR` when off** — reads as a broken launch and makes the per-artifact "use the template" path need a recovery command.
- **Moving the injected theme to the top of `<head>`** — same effect for free-form pages, but `:where()` also keeps it from beating any later author rule.

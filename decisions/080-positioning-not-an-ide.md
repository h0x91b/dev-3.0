# 080 — Positioning: mission control, not an IDE

## Context

Two close competitors — one an "Agent IDE", one a "Code Editor for AI agents" team/enterprise SaaS — look superficially similar to dev-3.0. We needed a sharp, durable positioning that tells a comparing visitor who each product is for, and that keeps dev-3.0 from drifting into IDE territory (the market's gravity pulls there; one competitor publicly admits it morphed from a terminal-orchestrator into an IDE).

## Decision

Position dev-3.0 as **"Mission control for the One Person Studio"** — a Kanban-first cockpit for a solo developer commanding a fleet of AI agents. Optimize for two things: the individual's **speed** (via focus, not editor time) and **beauty/ergonomics**; and explicitly **not be an IDE**. Applied to `README.md` (new `## Philosophy` and `## Which is for you?` sections, new subtitle) and `docs/index.html` (hero H1/subtitle + flow descriptor, `#philosophy`, `#ways-to-work`, `#compare` sections, `Why` nav link, title/OG/Twitter meta, CTA → "Ready to take command?"). Headline and subhead are founder-approved.

## Risks

The hard "not an IDE" stance constrains future feature choices on purpose: no embedded editor, no manual git UI, no native Jira/Linear/etc. integrations (those go through the agent's MCP). Comparison copy uses generic categories ("agent IDE", "team orchestrator") rather than naming rivals — safer, but may need revisiting if the market shifts.

## Alternatives considered

- Anti-IDE-contrast headline ("IDE manages your code, dev3 manages you") — rejected for the positive mission-control framing the founder picked.
- Naming competitors directly in the comparison — rejected as defensive; kept generic.
- Building toward an IDE (embedded editor, git UI, PM integrations) to match competitors — explicitly rejected; it contradicts the thesis.

See the positioning memory (`dev3-positioning-one-person-studio`) and the competitor-analysis notes on the orca-mapping task for the full 3-way analysis.

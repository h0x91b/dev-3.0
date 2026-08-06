# 182 — ask-dev3 feature-router skill

## Context

Users (and the agents serving them) don't remember every dev3 feature or the intended way to use it. We wanted a skill, modeled on Matt Pocock's `ask-matt` router, that answers "how is X done in dev3?" by teaching the intended flow instead of guessing. It ships to every dev3 install like the other managed skills.

## Decision

Added `ask-dev3` as an auto-installed agent skill (`ASK_DEV3_SKILL_CONTENT` in `src/bun/agent-skills.ts`, written into `.claude/.cursor/.agents/.codex/.opencode` skill dirs on startup, with an `openai.yaml` interface stub — same pattern as `dev3-bug-hunter`). Shape decided in a grilling session:

- **Audience:** the human user learning through the agent (not agent self-education).
- **Scope:** how-to + why (via decision records) + light troubleshooting.
- **Accuracy stance:** answer from the map first; read source (`decisions/`, `change-logs/`, code) only when the map is thin, the question is a "why", or there's a risk of being wrong.
- **Action stance:** explain, then *offer* to do it — never force. Troubleshooting is point-only (name `dev3 doctor` / logs / the relevant decision and stop; deep diagnosis is `/diagnosing-bugs`).
- **Structure:** a connected flow-map narrative like `ask-matt` (main flow → on-ramps → away-from-keyboard → verifying → vocabulary → broken → standalone), GUI-first with CLI only where it's the better path.
- **Coverage:** a curated core of the most frequently asked newcomer questions (21 situations), with everything else reached through source pointers.
- **Boundary with sibling skills:** explain the essence for the human, delegate step-by-step mechanics to `/dev3`, `/dev3-tmux`, `/dev3-project-config`, `/dev3-bug-hunter`.
- **Maintenance:** updated manually on the user's request, plus a soft nudge in AGENTS.md ("consider updating ask-dev3") for feature changes — deliberately no auto-sync mechanism.

## Risks

- **Drift:** the map can go stale as features change. Mitigated by the AGENTS.md nudge and manual curation; not by automation (an auto-sync from changelogs was considered and rejected as over-engineered).
- **Over-triggering:** the description is tuned to fire only on explicit how-to phrasing about dev3, not during normal coding work.

## Alternatives considered

- **Manual `/ask-dev3` only, no model invocation** (like `ask-matt`'s `disable-model-invocation`) — rejected: a discoverability skill that is itself undiscoverable is a chicken-and-egg problem.
- **Machine registry of user stories generating the SKILL.md** (like `ALL_TIPS`) — rejected: it kills the connected decision-tree prose that is the whole value of the router.
- **Auto-sync consuming `change-logs/`** — rejected: too much machinery for a curated map the user wants to control by hand.

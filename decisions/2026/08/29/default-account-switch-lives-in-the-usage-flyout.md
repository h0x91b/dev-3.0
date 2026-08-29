# The default-account switch lives in the usage flyout, pinned-only

## Context

The header rate-limit pill is an ambient readout. PR #1572 put a mutation on it: picking the
default agent account for new launches. The UX manifest pointed the other way — configuration
(`PRODUCT_UX_BIBLE.md` §"configuration", which lists "gh account" as its example) lives in
Settings, `global_header.allowed` in `ux-architecture.yaml` lists readouts only, and the memory
reclaim action is documented there as "the only mutation allowed in an ambient-status surface".

## Investigation

The review of #1572 found two things that had to be answered together. First, the placement
conflict above. Second, the flyout opens on **hover** (`useHeaderFlyout`, `variant: "bar"`, no
dwell) and its rows were live the moment the pointer entered the panel — verified in a browser,
every non-default row reported `aria-disabled=null` on a panel that was never pinned. Success was
silent, and hover-out closes the panel ~120 ms later, so the moved "Default" chip could vanish
before it was ever seen.

## Decision

Keep the switch on the readout, and make the pin the guard.

- `AgentUsagePanel` takes an `interactive` prop. `RateLimitIndicator` passes
  `isNarrow || flyout.pinned`: a hovered panel is read-only, a pinned one is choosable, and the
  BottomSheet on narrow is choosable because a sheet is opened deliberately.
- The subtitle says which mode it is in (`rateLimits.pinToSwitch` vs `rateLimits.panelSubtitle`).
- A success toast (`rateLimits.defaultSwitched`) is the receipt, because the panel is transient.
- No confirm dialog: the blast radius is a preselect for future launches, and running sessions
  keep their login. Confirmation is priced by blast radius, as the memory-reclaim rule already
  states.
- Settings → Agent Accounts stays the canonical home. Nothing else configurable may enter this
  panel; if a second setting ever wants in, that is the signal the surface was the wrong home.

Recorded in `ux-architecture.yaml` under `global_header.agent_rate_limit_indicator`, which is why
that file's budget in `src/bun/__tests__/ux-docs-budget.test.ts` moves 114 → 115 KB: compaction
would have meant deleting other rules' "why", which the budget's own note calls the failure mode.

## Risks

The header now carries two mutations (memory reclaim, this one) where the manifest previously
sanctioned exactly one. The mitigation is the "no second setting" clause above — an ambient
readout that accumulates configuration is the toolbar-creep anti-pattern under a different name.

Pinned-only costs a keyboard user nothing (focus enters the panel on pin) but does cost a mouse
user one extra click. That is deliberate.

## Alternatives considered

- **Move it to Settings only** — what the manifest said, but it throws away the reason the feature
  exists: you pick an account *while* comparing how much quota each has left.
- **Keep rows live on hover, add only the toast** — a receipt after the fact does not stop the
  accident, it only reports it.
- **A confirm dialog per switch** — over-priced for a preselect, and it would make the fast path
  (compare usage, switch, launch) slower than the settings screen it was meant to beat.

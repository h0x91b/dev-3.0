# Visual token and component decision

The UX Principal must recommend semantic roles and exact component variants.

## Button role matrix

| Semantic role | Use for | Avoid for |
|---|---|---|
| primary | One main safe action for the current screen or flow | Multiple competing CTAs, destructive actions |
| secondary | Useful supporting action | Main action, irreversible action |
| tertiary or ghost | Low-emphasis action that should stay visible | Critical path action |
| outline | Secondary action where border styling separates hierarchy | Dense repeated rows if noisy |
| link | Navigation or inline action | Form submission primary |
| icon | Compact repeated utilities | Ambiguous actions without labels |
| destructive | Delete, revoke, reset, disable, irreversible, dangerous | Safe routine action |
| neutral | Utility action with no semantic state | Actions that need risk/state semantics |
| accent or alternative | Product-specific emphasis already defined in tokens | Random color variety |

## State color matrix

| State | Token role | Notes |
|---|---|---|
| Success | success | Completed, healthy, active, passed. |
| Warning | warning | Needs attention, degraded, risky but not failed. |
| Danger | danger or destructive | Failed, blocked, destructive risk. |
| Info | info | Informational, neutral guidance. |
| Neutral | muted or neutral | Metadata, inactive, unknown. |

## Output format

```md
### Visual hierarchy and token decisions
- Primary CTA: `Create rule`, semantic role `primary`, component variant `default`.
- Secondary action: `Import`, semantic role `secondary`, component variant `outline`.
- Overflow action: `Export selected`, semantic role `secondary`, component variant `ghost` inside menu.
- Destructive action: `Delete rule`, semantic role `destructive`, component variant `destructive`, confirmation required.
- Status badge: `Degraded`, semantic state `warning`, badge variant `warning`.
```

## Rules

- Use existing token names when known.
- If exact component variant is unknown, write `component variant: existing equivalent of <semantic role>` and tell the implementation agent to inspect the component API.
- Never invent hex colors as the main recommendation.
- If a new semantic token is needed, mark it as a proposed design-system change, not a feature implementation detail.

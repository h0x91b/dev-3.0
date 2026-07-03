# UX decision entry template

Max ~5 lines / ~600 characters per entry. The rule itself lives in the bible/yaml;
this entry records only the *why*. Details stay in the PR and git history.

```md
## YYYY-MM-DD — <short imperative title>

- **Rule:** <one sentence — what future features must obey; cite bible §/yaml rule id>
- **Why:** <one sentence — rationale incl. the strongest rejected alternative>
- **Status:** Observed|Proposed. Evidence: `path/one.tsx`, `path/two.ts`
```

When the rule is later absorbed or superseded, compact the entry to one dated line
pointing at the bible section that owns it now.

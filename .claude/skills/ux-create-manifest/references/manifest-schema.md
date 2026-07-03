# UX manifest schema

The machine-readable file should live at:

```text
docs/ux/ux-architecture.yaml
```

YAML is preferred because agents can patch it easily. Keep it human-readable. Avoid huge generated dumps.

## Top-level schema

```yaml
ux_architecture:
  version: 1
  updated_at: "YYYY-MM-DD"
  source: "derived_from_repository"
  confidence: "low|medium|high"

  product:
    name: ""
    app_type: "website|web_app|full_screen_web_app|admin_console|dashboard|mixed"
    primary_users: []
    primary_jobs: []

  evidence:
    audited_paths: []
    key_files: []
    ignored_paths: []
    limitations: []

  objects: {}
  navigation: {}
  surfaces: {}
  action_types: {}
  screen_patterns: {}
  design_tokens: {}
  complexity_budgets: {}
  placement_rules: []
  anti_patterns: []
  open_questions: []
```

## Object entry

```yaml
objects:
  project:
    label: "Project"
    plural: "Projects"
    observed: true
    primary_route: "/projects"
    detail_route: "/projects/:id"
    owner: "workspace"
    owns: ["deployment", "alert_rule"]
    common_actions: ["create", "edit", "archive"]
    evidence: ["app/projects/page.tsx", "app/projects/[id]/page.tsx"]
```

## Surface entry

```yaml
surfaces:
  page_toolbar:
    purpose: "Frequent page-scoped actions, search, filters, and view modes."
    allowed: ["page_action", "search", "filter", "view_mode"]
    forbidden: ["global_destination", "durable_configuration", "destructive_primary"]
    visible_budget:
      max_actions: 3
      overflow_after: 3
    evidence: []
```

## Placement rule entry

```yaml
placement_rules:
  - id: "bulk-actions-selection-toolbar"
    when:
      type: "bulk_action"
      scope: "selected_items"
    place_in: "selection_toolbar"
    reject: ["global_nav", "row_actions", "page_header_primary"]
    rationale: "Bulk actions only make sense after selection exists."
    status: "observed|inferred|proposed"
    evidence: []
```

## Token entry

```yaml
design_tokens:
  button_variants:
    primary:
      component_variant: "default"
      use_for: "One main safe action for the current screen."
      max_per_screen: 1
    secondary:
      component_variant: "secondary"
      use_for: "Supporting visible action."
    destructive:
      component_variant: "destructive"
      use_for: "Delete, revoke, reset, disable, irreversible, or security-sensitive action."
```

# Feature planning protocol

Use this protocol for every UI feature.

## Step 1: Context loading

Read:

- `docs/ux/PRODUCT_UX_BIBLE.md`
- `docs/ux/ux-architecture.yaml`
- `docs/ux/UX_DECISIONS.md`
- relevant routes, components, tokens, layouts, and feature modules

If these docs do not exist, run Manifest Bootstrap Mode or use `ux-create-manifest`.

## Step 2: Feature classification

Classify the feature:

```yaml
feature:
  user_job: ""
  object: ""
  workflow: ""
  class: "destination|primary_action|page_action|object_action|bulk_action|filter|view_mode|configuration|destructive|diagnostic|onboarding|expert_shortcut|status|notification|visualization"
  scope: "global|workspace|page|selected_items|single_object|row|flow_step|user_preference|admin_only"
  frequency: "constant|daily|occasional|rare"
  risk: "safe|reversible|destructive|security_sensitive|privacy_sensitive|billing_sensitive"
  discoverability_need: "high|medium|low"
```

## Step 2b: Triage

Run the Architecture-change gate from `SKILL.md`. If the feature is manifest-compliant
(no new destination, surface, placement rule, budget exception, token role, or object),
produce the **Lite report** inline with zero doc writes and skip Step 6.

## Step 3: Surface decision

Answer:

- What surface owns this class of feature in the manifest?
- Does the feature need a route, tab, toolbar control, menu item, settings entry, command-palette entry, modal, drawer, inspector panel, empty-state action, or notification?
- Is the surface within budget?
- What existing control should this be grouped with or replace?
- What placements are explicitly rejected?

## Step 4: Token and component decision

Answer:

- Existing component to reuse.
- Semantic token role.
- Concrete component variant.
- Icon usage.
- Label and microcopy.
- State tokens: success, warning, danger, info, neutral.

## Step 5: Interaction contract

Define:

- Trigger.
- Preconditions.
- Default state.
- Loading state.
- Empty state.
- Error state.
- Permission-denied state.
- Success state.
- Confirmation or undo.
- Keyboard and focus.
- Responsive behavior.

## Step 6: Manifest patch

Patch docs only when the feature introduces durable architecture:

- New object or route.
- New nav group or menu label.
- New surface pattern.
- New action placement rule.
- New token role mapping.
- New exception to a complexity budget.

The rule goes into the bible/yaml; the *why* goes into `UX_DECISIONS.md` as one compact
entry (≤5 lines). No changelog files, no per-feature plan files — git history and the PR
carry those. If none of the bullets above apply, this step writes nothing.

## Step 7: Implementation brief

Produce a brief that can be handed directly to a coding agent.

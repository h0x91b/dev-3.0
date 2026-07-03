# Discovery protocol

The initial manifest must be grounded in the actual app.

## Repository discovery

Inspect, where present:

- `package.json`, lockfiles, workspace files, monorepo config.
- `src/`, `app/`, `pages/`, `routes/`, `components/`, `features/`, `modules/`, `layouts/`, `screens/`, `views/`.
- Router definitions: Next.js App Router, Next Pages Router, React Router, Remix routes, TanStack Router, Vue Router, SvelteKit routes, Angular routes.
- Design system files: `components/ui`, `ui`, `design-system`, `theme`, `tokens`, `tailwind.config.*`, `globals.css`, CSS variables, styled components, vanilla-extract, CSS modules.
- Navigation files: `sidebar`, `nav`, `menu`, `tabs`, `breadcrumb`, `command`, `palette`, `routes`, `sitemap`.
- Feature modules and domain folders.
- Tests and story files that show intended component usage.
- Existing docs: `README`, `docs`, `AGENTS.md`, `CLAUDE.md`, product specs.

## UX inventory targets

Collect:

- Top-level routes and labels.
- Auth, onboarding, billing, settings, admin, dashboards, detail pages, list pages.
- Navigation hierarchy and grouping.
- Menu entries and their destination/action type.
- Toolbars and action bars.
- Tables and their row actions, bulk actions, filters, sort, search, columns.
- Forms and primary/secondary actions.
- Modals, drawers, popovers, inspectors.
- Status cards, metric cards, charts, alerts, toasts.
- Empty, loading, error, permission-denied, offline, partial-data states.
- Button variants and semantic color tokens.

## Evidence quality

Prefer direct evidence:

```text
components/layout/AppSidebar.tsx defines top-level navigation labels.
app/projects/[id]/page.tsx shows project detail tabs.
components/ui/button.tsx defines variants: default, secondary, outline, ghost, destructive, link.
```

Avoid vague claims:

```text
Bad: The app has a good sidebar.
Good: Observed sidebar groups primary destinations into Projects, Alerts, Settings in components/layout/AppSidebar.tsx.
```

# Change Logs

Conflict-free changelog for parallel agent workflows. Each change gets its own file.

## Format

**Path:** `change-logs/YYYY/MM/DD/<type>-<short-slug>.md`

The `YYYY/MM/DD` is the **expected PR merge date**, not the day you started. If a task spans more than one day, rename the file/folder to the actual merge day before merging — entries are grouped by ship date in the UI.

**Type prefixes:** `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`

**Content:** Plain text, 1-3 sentences describing what was done. No frontmatter, no headers.

## Example

File: `change-logs/2026/02/21/feature-add-dark-mode.md`

```
Add dark mode toggle to the settings panel. Uses Tailwind dark: variant with a class-based strategy on <html>.
```

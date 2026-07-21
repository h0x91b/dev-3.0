# Change Logs

Conflict-free changelog for parallel agent workflows. Each change gets its own file.

## Format

**Path:** `change-logs/YYYY/MM/DD/<type>-<short-slug>.md`

The `YYYY/MM/DD` is the **expected PR merge date**, not the day you started. If a task spans more than one day, rename the file/folder to the actual merge day before merging — entries are grouped by ship date in the UI.

**Type prefixes:** `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`

**Optional popover priority (`<type>-<NN>-<slug>`):** the update-ready popover shows only the top few features (`MAX_POPOVER_FEATURES`) and folds the rest into "+N more". Put a two-digit number right after the type — `00` = most prominent, higher = lower — to pick which features win those slots; omit it and the entry sits mid-pack (priority 50). It only reorders `feature-` entries (the slotted list); `fix-`/others just add to a count. The type is still parsed from the first dash, so `feature-00-add-dark-mode` is still a `feature`. Rank honestly (reuse the tips coolness rubric) and give dev-only/internal features a high number so they don't push real features out of the popover.

**Content:** Plain text, 1-3 sentences describing what was done. No frontmatter, no headers.

**Optional `Short:` line (required for `feature-` entries):** the full first sentence is what the Changelog screen shows, but the **update-ready popover** (header "Update" plaque) has room only for a tiny "what's new" preview. Add a `Short:` line — **≤6 words**, no trailing period — that captures the change as a headline. Put it as the **first line**, followed by a blank line, then the normal content. It is stripped before the full title is extracted, so it never affects the Changelog page.

- **Every `feature-` entry MUST have a `Short:` line** (features lead the popover).
- `fix-` entries: add one when the fix is user-visible enough to headline; otherwise a crude auto-derived short (first few words of the sentence) is used as a fallback.
- `refactor-`/`docs-`/`chore-`: usually skip — they don't surface in the popover.

## Example

File: `change-logs/2026/02/21/feature-00-add-dark-mode.md`

```
Short: Dark mode toggle

Add dark mode toggle to the settings panel. Uses Tailwind dark: variant with a class-based strategy on <html>.
```

Short: Task descriptions render as Markdown

The task detail view now renders the description as Markdown, with headings, lists, inline and fenced code, links and emphasis, through the same sanitized renderer as PR comments; `seq:N` / `pr:N` references stay clickable chips, raw HTML shows as literal text, and Edit still opens the raw source.

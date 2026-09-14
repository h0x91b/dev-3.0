Short: Read a task's conversation in Agent traffic

The Agent traffic inspector gained a Conversation tab: pick a task and read what its agent and
you actually said, beside the messages agents sent each other. It shows the newest session
first (with a picker when a task ran several), a page of turns at a time with "Load earlier
turns", and says whether it read the live transcript or dev3's archived copy of a finished
task. Claude Code and Codex transcripts are the ones dev3 can parse; anything else says so
instead of looking silent. Messages render as Markdown through the app's existing safe renderer, and a long one shows its first 2000 characters — cut on a Markdown block boundary so nothing renders broken — with Show more opening the rest in place. Listing the sessions opens no files and only the one you are reading is
parsed, so the tab stays fast on a task carrying tens of megabytes of transcript.

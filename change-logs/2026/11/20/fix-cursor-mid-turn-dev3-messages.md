Short: Cursor reads messages mid-turn

Fix `dev3 message`s piling up in Cursor Agent's follow-ups queue while it works through a long turn. A user-level Cursor `postToolUse` hook now hands a busy Cursor agent its held messages at its next tool call, the same mailbox Claude Code already uses.

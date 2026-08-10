Short: AI Review settings stop resetting

Project Settings saves no longer get silently reverted when a .dev3 config file already owns the field — the value is written back into that file instead of projects.json, and the Project tab now shows the config that will actually run. The AI Review column also defaults to Claude Opus 5 (X-High) and rewrites the removed `claude-bypass-sonnet` preset instead of falling back to whatever preset happens to sit first in the list.

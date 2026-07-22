Diagnostic logs now redact task prompts, URLs, credentials, environment values, and command arguments while retaining useful local failure details. Local daily logs are bounded to the current day plus 13 previous days, and logging or cleanup failures remain non-fatal.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1069)

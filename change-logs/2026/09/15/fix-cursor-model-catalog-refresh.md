Short: Cursor presets point at live models

The built-in Cursor Agent presets pointed at model ids the CLI no longer serves, so a launch failed immediately with "Cannot use this model". They now use current catalog slugs (Opus 5, Sonnet 5, GPT-5.6 Sol, Grok 4.6, Gemini 3.7/3.8 Flash, Composer 2.5), and an upgrade replaces a stale id in agents.json only when it is still exactly the one dev3 shipped — a model or preset name you changed yourself is left alone.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#1664)

Short: Codex explains a too-old CLI

Launching a Codex preset whose model the installed CLI predates now prints a dev3 notice naming the installed version, the version the model needs and how to upgrade, instead of dying on an opaque upstream 400. The default GPT-6 Astra preset on Codex CLI older than 0.153.1 was the reported case; the launch still proceeds so nothing that worked before is blocked.

Suggested by @ittaiz (h0x91b/dev-3.0#1667)

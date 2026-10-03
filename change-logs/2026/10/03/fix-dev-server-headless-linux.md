Short: Dev server runs on headless Linux

`bun run dev` (and so the repo's `dev3 dev-server start`) no longer fails on Linux hosts without a display or WebKitGTK, such as WSL, SSH sessions and containers: it serves the UI through the headless `dev3 remote` server, run from source on a throwaway QA board, so browser QA works there. `--headless` or `DEV3_DEV_HEADLESS=1` asks for it anywhere.

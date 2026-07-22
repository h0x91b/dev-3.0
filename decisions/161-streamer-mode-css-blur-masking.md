# 161 — Streamer mode masks via CSS blur, not text redaction

## Context

Streamer mode must hide identity-bearing UI values (account emails/labels, orgs, home-dir paths, tunnel URLs, QR code) during screen recordings. Two candidate mechanisms: replace the text with placeholders, or blur it with CSS.

## Decision

Pure CSS masking: `initStreamerMode()`/`setStreamerMode()` (`src/mainview/streamer-mode.tsx`) toggle `data-streamer="on"` on `<html>`; sensitive elements carry `streamer-private` (em-relative blur, scales with font size) or `streamer-private-media` (strong fixed blur for the remote-access QR — em-based blur would survive QR error correction and stay scannable). Rules live in `index.css`. Toggling re-renders nothing; new surfaces just add the class. State persists in localStorage (`dev3-streamer-mode`), per client like the theme — desktop and each remote browser mask independently. A `?streamer=on|off` URL parameter overrides and persists on load — the machine entry point for agent-driven QA (`agent-browser` appends it so every screenshot is masked; mandated in AGENTS.md "Manual UI QA in a browser" and the debug-ui skill). It persists (rather than session-only) so `isStreamerModeOn()` and the settings toggle stay consistent with the html attribute.

## Risks

Values stay in the DOM and clipboard (threat model is a recording viewer, not a local inspector). Terminal panes are not maskable — documented in the setting description and help topic. Gaussian blur on static text is theoretically attackable, accepted for the casual-viewer threat model.

## Alternatives considered

Text replacement (per-surface logic, silent misses, breaks demo continuity); hover-to-reveal (leaks live on stream); GlobalSettings RPC persistence (masking is a per-display concern; avoids schema churn).

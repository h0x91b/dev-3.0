# 129 — Terminal immersive fullscreen stays in the renderer

## Context

The task terminal needs a focused fullscreen surface that works in both Electrobun and browser remote mode. The existing tmux zoom control is user-owned state and must remain independent from app chrome.

## Investigation

The app already has a screen-based `Route` and a task workspace that can render the terminal without the inspector. Native/browser fullscreen differs by transport, while tmux `resize-pane -Z` mutates pane state and would make an app view toggle destructive to the user's layout.

## Decision

Model immersive fullscreen as an ephemeral `App` state while preserving the current `Route`; render a dedicated `dev3`/Exit strip and a task workspace with the inspector hidden. Register F11 and Cmd/Ctrl+Shift+F in `App.tsx`, and route native, browser, toast, and pending notification clicks through one callback that clears the state before normal task navigation.

## Risks

Entering from the split view remounts the task workspace, so the PTY display reconnects while the tmux session remains alive. The mode intentionally does not persist across reloads and hides transient app overlays until the user exits.

## Alternatives considered

Native/browser Fullscreen API was rejected because it is transport-dependent and does not provide the same app-level chrome. tmux zoom was rejected because it changes pane layout and conflicts with the separate manual `Zoomed` control.

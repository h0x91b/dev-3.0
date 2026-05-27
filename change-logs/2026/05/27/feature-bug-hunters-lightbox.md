Added a "Find bugs" lightbox triggered from the task header. Pick how many hunters (1–6, default 3), agent, and config, and dev-3.0 splits the right half of the task session vertically into that many panes — each launches the chosen agent and auto-types `/dev3-bug-hunter` so the read-only seeded bug hunt starts immediately. Each pane is tracked in `sessionState.panes` so recovery and exit reconciliation keep working.

Suggested by @ittaiz (h0x91b/dev-3.0#540)

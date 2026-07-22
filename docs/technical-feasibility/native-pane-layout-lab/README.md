# Native pane layout lab

This debug-only lab closes the renderer/layout slice of the tmux-removal feasibility proof. It combines a pure immutable `SplitTree`, pane-ID-keyed fake terminal sessions, and a responsive renderer without importing production terminal, RPC, PTY, filesystem, or tmux code.

## Reproduce

Run the deterministic tests and the five-second six-pane stress case:

```bash
bunx vitest run --config vitest.config.ts src/mainview/__tests__/split-tree.test.ts src/mainview/labs/native-pane/__tests__
bun scripts/benchmark-native-pane-layout.ts
```

Open **View → Debug → Native Pane Layout Lab** to exercise the renderer. The 1, 2, and 6 pane presets use independent output, input, and resize channels; wide viewports tile the tree while narrow viewports mount only the active pane and expose pager buttons plus arrow-key navigation.

## Recorded baseline

The committed [baseline JSON](baseline-2026-07-22.json) was captured on Bun 1.3.14, macOS arm64, Apple M4 Max. Over 5.0 seconds, six panes produced 3,684 output, 432 input, and 1,746 resize events while consuming 173.75 ms of process CPU time (3.47% of one core). The observed heap delta was 585,500 bytes; each stream's replay buffer is independently capped at 240 lines.

After the run, active sessions, timers, and all three subscription classes returned to zero. Tests also abort a live stress run on lab unmount and verify zero remaining timers. These synthetic numbers establish a regression baseline and cleanup boundary; they do not predict real PTY or terminal-emulator cost.

## Browser evidence

- [Desktop: six tiled independent panes](desktop-6-panes.png)
- [Narrow: one active pane with visible pager](narrow-6-panes.png)

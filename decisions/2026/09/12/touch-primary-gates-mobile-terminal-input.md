# Touch-primary detection gates the mobile terminal input stack

## Context

`TaskTerminal` and `ProjectTerminal` switched into the mobile input stack (TerminalComposer, ExtraKeyBar, touch compose mode, the copy-mode scroll poll) whenever `navigator.maxTouchPoints > 0` in browser remote mode. A Windows laptop with a touchscreen reports touch points even when driven entirely by a mouse, so a 1900px desktop session over `dev3 remote` got the phone composer and a vw-sized key bar.

## Decision

`isTouchPrimary()` in `src/mainview/utils/platform.ts` is the single gate: `maxTouchPoints > 0` stays as the cheap precondition, and `matchMedia("(pointer: coarse)")` — the device's *primary* pointer per CSS Media Queries 4 — discriminates a phone/tablet from a touchscreen laptop. Where `matchMedia` is unavailable it falls back to the old touch-points-only behaviour. Both call sites (`TaskTerminal.tsx`, `ProjectTerminal.tsx`) use it; the value is read once per render, not subscribed — plugging in a mouse mid-session does not retract the composer until the next mount, which matches the old non-reactive behaviour.

## Risks

A convertible flipped into tablet mode after load keeps its laptop verdict until remount. Some browsers evaluate `pointer: coarse` per current primary pointer, so a phone with a paired Bluetooth mouse loses the composer — acceptable, since a hardware keyboard/mouse setup is exactly the desktop experience.

## Alternatives considered

Viewport width: wrong axis — an iPad is wide, a narrow desktop window is not a phone. `(hover: none)`: overlaps coarse but misclassifies hover-capable styluses. UA sniffing: rejected as unmaintainable.

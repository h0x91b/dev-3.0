# Hide the WebKit caret on the terminal container

## 1. Context
Issue #2124: a blinking blue line on the left edge of a focused terminal in the desktop app. ghostty-web marks the terminal container `contenteditable="true"` (input plumbing), and the container's first child is a block `<canvas>`. WebKit then paints its native insertion caret beside that canvas: full canvas height, system accent colour, a smooth fade blink.

## 2. Investigation
I sampled the reporter's video frame by frame. The line sits exactly on the terminal's left edge, runs the full height and fades out and back in about every 1.1 s, which matches a caret, not a focus ring. The mechanism reproduces in Playwright WebKit with a bare contenteditable+canvas page, and `caret-color: transparent` removes it. It does not show in headless browser QA of the live app: once the canvas has been drawn, headless WebKit composites it above the caret, while the desktop WKWebView paints the caret on top. Chromium never paints it. A clone of the live container whose canvas is blank does show the caret.

## 3. Decision
Set `caretColor: "transparent"` inline on the `[data-terminal]` container in `src/mainview/TerminalView.tsx`, mirroring what was already done for ghostty's hidden textarea. Focus stays visible through the terminal's own canvas cursor, plus the accent border on a focused native pane.

## 4. Risks
None known: nothing renders through that caret. A future ghostty-web that drops contenteditable makes the line a no-op.

## 5. Alternatives considered
Removing `contenteditable` after `term.open()` could break ghostty's IME and paste paths. Redirecting focus to the hidden textarea touches every keyboard path. Both are much riskier than one style property.

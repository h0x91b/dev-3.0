# Linux desktop: read the host clipboard when WebKitGTK delivers an empty paste

## Context

h0x91b/dev-3.0#2041: Ctrl+V with an image on the clipboard did nothing in the Linux desktop app. Both image paths (`TerminalView`'s paste interceptor and `useClipboardPaste`) start from the paste event's own files/items, and only fall back to the host clipboard when an `image/*` item is present. WebKitGTK provides neither.

## Investigation

Reproduced in WebKitGTK 2.50.4 (Ubuntu 25.04 container, private Xvfb, clipboard owned by a synthetic GTK process): an image clipboard yields a paste event with `isTrusted: true` and empty `types`, `items`, `files` and text, for both a GTK Ctrl+V key event and the Paste editing command. An empty clipboard yields the identical payload, so the two cannot be told apart in the page. The reporter saw the same on 2.54. Electrobun 1.18.1's Linux `clipboardAvailableFormats`/`clipboardReadImage` use `gtk_clipboard_wait_*` on the GTK main thread and return PNG. End to end on the real Electrobun 1.18.1 linux-arm64 core (same container, XTest Ctrl+V, `__electrobunWebviewId` set by Electrobun itself): `main` leaves the field empty with no RPC, this branch reads a 155-byte PNG through the real FFI in 5–10 ms; an empty clipboard returns `null` in 1–4 ms; text never calls the RPC.

## Decision

`shouldReadHostClipboardImage` (`src/mainview/utils/hostClipboardImage.ts`) asks the host clipboard only for a trusted paste, in the desktop shell (`!isRemote()`), on Linux, with no image file/item and no text. `readHostClipboardImage` bounds the wait (10 s) and maps the reply: `image` → paste the path once, `none` → quiet (the ordinary empty Ctrl+V), `failed`/`timeout` → `imagePaste.failed` toast. `pasteClipboardImage` now throws when the clipboard reports an image it cannot read or convert, so a failure is no longer indistinguishable from an empty clipboard.

## Risks

- The Electrobun FFI call is synchronous and has no timeout. Measured with an X11 owner that answers `TARGETS` (advertising `image/png`) but never sends the bytes: WebKit itself delayed the paste event ~34 s, then `clipboardReadImage` froze the bun process for 125 s (no HTTP answers at all), then threw. The renderer's 10 s bound fired on time (one toast, the late failure discarded), but every other RPC waited. A fully silent owner never stalls bun: WebKit then fires no paste event. Before this change Linux never reached this FFI path, so the exposure is new, though it needs a misbehaving clipboard owner.
- Wayland is not exercised (no compositor and no network in the test container); GTK3's clipboard abstracts it and the window is focused at paste time. Only X11 on Xvfb was run.
- A reply after the timeout still saves a file under `uploads/`, but it is not pasted.

## Alternatives considered

- Spawning `wl-paste`/`xclip`: async and killable, but optional binaries that GTK already makes unnecessary.
- Forwarding `^V` to the PTY so the agent reads the clipboard: agent- and tool-dependent, and does nothing for text fields.
- Gating only on `!isRemote()`: would also query the host on empty macOS/Windows pastes, whose webviews already deliver image files.

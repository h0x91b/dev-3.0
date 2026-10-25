# Linux desktop: read the host clipboard when WebKitGTK delivers an empty paste

## Context

h0x91b/dev-3.0#2041: Ctrl+V with an image on the clipboard did nothing in the Linux desktop app. Both image paths (`TerminalView`'s paste interceptor and `useClipboardPaste`) start from the paste event's own files/items, and only fall back to the host clipboard when an `image/*` item is present. WebKitGTK provides neither.

## Investigation

Reproduced in WebKitGTK 2.50.4 (Ubuntu 25.04 container, private Xvfb, clipboard owned by a synthetic GTK process): an image clipboard yields a paste event with `isTrusted: true` and empty `types`, `items`, `files` and text, for both a GTK Ctrl+V key event and the Paste editing command. An empty clipboard yields the identical payload, so the two cannot be told apart in the page. The reporter saw the same on 2.54. Electrobun 1.18.1's Linux `clipboardAvailableFormats`/`clipboardReadImage` use `gtk_clipboard_wait_*` on the GTK main thread and return PNG. End to end on the real Electrobun 1.18.1 linux-arm64 core (same container, XTest Ctrl+V, `__electrobunWebviewId` set by Electrobun itself): `main` leaves the field empty with no RPC, this branch reads a 155-byte PNG through the real FFI in 5–10 ms; an empty clipboard returns `null` in 1–4 ms; text never calls the RPC.

## Decision

`shouldReadHostClipboardImage` (`src/mainview/utils/hostClipboardImage.ts`) asks the host clipboard only for a trusted paste, in the desktop shell (`!isRemote()`), on Linux, with no image file/item and no text. `readHostClipboardImage` bounds the renderer's wait (10 s) and maps the reply: `image` → paste the path once, `none` → quiet (the ordinary empty Ctrl+V), `failed`/`timeout` → `imagePaste.failed` toast. `pasteClipboardImage` throws when the clipboard reports an image it cannot read or convert, so a failure is distinguishable from an empty clipboard.

On Linux the host reads through `readHostClipboardImage` in `src/bun/clipboard-image-reader.ts`, which runs Electrobun's two clipboard FFI calls in a one-shot worker (`src/bun/workers/clipboard-image-worker.ts`). The worker is bundled to `dist/workers` by `scripts/build-cli.ts` and configured in `index.ts`. It dlopens the library Electrobun already loaded, so the GTK work still runs on the GTK main thread; only the waiting moves off bun's event loop. Rules:
- one read at a time, with a 10 s host deadline;
- the slot stays taken until that worker's FFI call returns, and only the read that owns the slot can release it;
- a late reply is dropped before conversion or any file write;
- the worker is unref'd so it never holds the app open at quit.

macOS and Windows keep the direct call.

Measured with the integrated reader on the real Electrobun 1.18.1 linux-arm64 core, using an X11 owner that answers `TARGETS` (offering `image/png`) but never sends the bytes. Page responsiveness is judged by pixel diffs of a rAF box and of a clicked button:
- WebKit holds the paste event ~33 s, with the page frozen. This happens on `main` too, and on `main` WebKit's default paste then re-reads the clipboard, keeping the page frozen ~155 s.
- After the event, the page stays responsive (about 51 ms), bun's heartbeat never stops, the RPC fails at 10.0 s with one toast, and a second paste is refused as busy in 1 ms.
- After GTK gives up (~124 s), a healthy owner pastes in 20 ms.
- Closing the window mid-wedge exits in ≤ 5.7 s. With the direct call, bun was down for 125 s and the close was ignored.

## Risks

- A worker wedged in GTK cannot be killed; it is held until GTK gives up (~124 s measured), capped at one by the single-flight slot.
- WebKit's own ~33 s pre-event freeze is outside our control (also on `main`).
- While GTK sits in that nested wait, other Electrobun main-thread calls run inside it. Click, resize and close were verified; window creation, menus and dialogs during a wedge were not.
- Not exercised: a real Wayland session's XWayland clipboard bridge (Electrobun forces `GDK_BACKEND=x11`, so the protocol is always X11), x86_64 (all runs were arm64), and the full dev3 app (the lab mirrored `pasteClipboardImage` around the real reader and worker).
- On Linux there is no host-thread fallback: a missing or unconfigured worker bundle (or one that fails to start) rejects the read, logs a warning once and shows `imagePaste.failed`, rather than bring back the 125 s freeze. Every build path (`build:cli` in the release workflows, `bun run dev`/`start`) bundles it; the headless server does not configure it, and its browser clients read their own clipboard.
- Electrobun's per-read `malloc` leak is unchanged.

## Alternatives considered

- A killable child process (GTK through FFI, or `wl-paste`/`xclip`): a spawn and `gtk_init` per paste, packaging, and optional tools. Not needed once the worker passed the responsiveness checks.
- An async clipboard API in Electrobun: the right long-term fix, but not available in a release we can pin.
- Forwarding `^V` to the PTY so the agent reads the clipboard: agent- and tool-dependent, and does nothing for text fields.
- Gating only on `!isRemote()`: would also query the host on empty macOS/Windows pastes, whose webviews already deliver image files.

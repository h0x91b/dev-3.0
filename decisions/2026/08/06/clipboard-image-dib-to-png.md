# 216 — Convert Windows clipboard DIB bytes to PNG ourselves

## Context

Pasting a screenshot on Windows produced nothing usable. Two independent causes sat behind one symptom, both inside "read the host clipboard from the bun process":

- `electrobun 1.18.1`, `package/src/native/win/nativeWrapper.cpp` → `clipboardReadImage()` returns **raw CF_DIB bytes** and carries the comment `TODO: Implement proper PNG conversion using GDI+ or similar`. macOS (`nativeWrapper.mm`) returns real PNG via `NSPasteboard`. We wrote those DIB bytes into a file named `.png` — a corrupt file.
- The same version calls `OpenClipboard(nullptr)` with no retry loop (upstream `main` has one), so a clipboard held open by another process yields no formats and `pasteClipboardImage` returns `null` with no user-visible trace.

## Investigation

Verified against the pinned version, not upstream `main`: `raw.githubusercontent.com/blackboardsh/electrobun/v1.18.1/package/src/native/win/nativeWrapper.cpp`. No agent can run Windows, so the fix had to be provable by tests on macOS.

Also established what consumes the pasted path: the agent on the other end of the prompt. The Claude API accepts only JPEG, PNG, GIF, and WebP (`platform.claude.com/docs/en/build-with-claude/vision` → "Supported formats"). So wrapping the DIB in a 14-byte `BITMAPFILEHEADER` and saving `.bmp` was rejected — it would produce a file that exists, opens in a viewer, and is unreadable exactly where it is used.

## Decision

Two layers, in this order:

1. **Prefer the paste event's own files.** `imageFilesFromClipboard` (`src/mainview/utils/clipboardImageFiles.ts`) reads `clipboardData.files`, falling back to `items[i].getAsFile()`. The webview has already decoded the clipboard bitmap into real PNG bytes, and in remote mode it is the user's own device rather than the app host. `TerminalView`'s paste interceptor now uses this first; `useClipboardPaste` already did something similar.
2. **Convert what the host clipboard gives us.** `clipboardImageToPng` (`src/bun/clipboard-image.ts`) passes PNG through, strips a `BITMAPFILEHEADER` off a whole BMP, and converts a 24/32-bit uncompressed DIB to PNG (BGR→RGB, bottom-up un-flip, `deflateSync` + hand-written IHDR/IDAT/IEND and CRC32). Anything else is refused rather than saved as a broken `.png`. `pasteClipboardImage` calls it before `saveUploadedFile`.

A failed paste now raises `toast.error(t("imagePaste.failed"))` instead of only `console.error`.

**Deletion condition:** layer 2 exists solely because of that upstream TODO. When electrobun's Windows `clipboardReadImage` returns PNG (and its `openClipboardWithRetry` reaches a release we depend on), delete `src/bun/clipboard-image.ts` and its test, and let the bytes go straight to `saveUploadedFile`. Layer 1 stays regardless — it is the correct source on every platform.

## Risks

- The converter covers 24/32-bit `BI_RGB`/`BI_BITFIELDS` only. A palette (≤8-bit) or RLE-compressed DIB is refused with a toast, not converted. Screenshots are 32-bit, so this is the tail.
- 32-bit `BI_RGB` leaves the 4th byte undefined; we force alpha opaque unless a V4/V5 header declares a non-zero alpha mask. A source that writes meaningful alpha into a 40-byte header would lose it — the alternative (trusting the byte) produces a fully transparent image, which is worse.
- **Not verified on Windows by any agent.** All assertions are mutation-proved on macOS (22 mutations, all caught); the Windows behaviour is reasoned from the pinned upstream source.
- The PNG encoder is hand-written, so its output was decoded by three implementations that share no code with it: Chromium's decoder via `canvas.getImageData` (returned the four expected pixel colours), Apple ImageIO via `sips` (2x2, 8-bit, 4 samples per pixel), and Python `zlib` (chunk CRCs + inflated scanlines). The test suite keeps the CRC half of that permanently: `decodePng` in the test checks every chunk against `crc32` from `node:zlib` rather than our own table.

## Alternatives considered

- **Wrap the DIB as BMP and save `.bmp`** — valid file, unreadable by the consumer (see Investigation). Rejected.
- **Only prefer the paste event's files, leave the RPC alone** — leaves a fallback that still writes corrupt `.png` files whenever it is reached. Rejected.
- **Patch electrobun / bump the dependency** — the fix is not in a release we can pin, and a bump drags unrelated native changes into a Windows port that is still stabilising.

# File preview bodies from an internal `fileViewers` slot

## Context

Inventory item 2.1 of the GUI move to Cordis plugins (coordinator task seq:2526). `FilePreviewModal` picked
its body with a `switch` on the preview kind. Custom file renderers are the most useful contribution for
extensions, so the body becomes a slot. The hard part is review comments: a text selection anchors to a line
range (`file-range`), and a click on an image anchors to a region (`image-region`). That anchoring must not
move into viewers.

## Decision

- `src/mainview/file-viewers/registry.ts` declares the internal `fileViewers` contribution slot. An item has
  `matches({ preview, path, showRaw })` and a `component`. The first item by `order` whose matcher holds
  draws the body.
- `src/mainview/file-viewers/builtins.tsx` holds dev3's viewers, in this order: markdown (10), code (20),
  image (30), media (40), and one notice viewer (50) for binary, too-large, directory and not-found. Loading
  stays in the host.
- **Anchoring stays in the host, through the frame.** For text, the host draws the selectable body: it reads
  the selection, draws the comment button and adds the truncated note. For images, the host draws the region
  overlay and the size line around the viewer.
  - A viewer gets no anchoring model and no callback. To give lines to a selection, it marks them with
    `data-preview-line`, which the host already read before this change. For the overlay, it puts
    `imageRef` on its picture.
  - A viewer that does neither still works: a selection over it becomes an excerpt-only comment, and an
    image gets no overlay.
- **Guards.**
  - A throwing matcher counts as no match, logged once per viewer id (`viewerMatches`).
  - A crashing viewer shows a one-line notice. When it is an extension's viewer, the built-in for the same
    file renders under a notice that says so. A crashed built-in, or a built-in fallback that crashes too,
    shows a notice that the file cannot be shown, and nothing else.
  - The boundary remounts per file, so the next file retries the viewer.
- Matchers run only when the preview, the Raw toggle or the slot changes, not on every render. Until the
  built-ins have registered, the modal draws them directly, the same hand-over `SlotHost` uses.
- Parity check: the dialog's outer HTML for 11 states is byte-identical before and after, with and without
  registered built-ins. The states are markdown, raw markdown, code with a target line, commented lines and
  truncation, image, image in comment mode, video, binary, too-large, directory, not-found, and loading.

## Risks

`data-preview-line` and `imageRef` become a public contract once the slot opens, which is listed as an
opening-track precondition in `docs/extensions-platform.md`. An extension viewer inside the text frame is
selectable host content: what it renders can be quoted into a comment excerpt.

## Alternatives considered

- An `onSelectRange(start, end, excerpt)` callback passed to the viewer: rejected. Each viewer would have to
  turn a DOM selection into lines itself, which moves anchoring logic into every viewer. With the frame and
  the line marks, the viewer only declares which element is which line.
- The viewer draws the whole body, including the frame: rejected. The comment button, the overlay and the
  find bar's search root would then depend on each viewer.
- One viewer per preview kind, with no matcher: rejected. A CSV table or a JSON tree needs to choose by path
  inside the `text` kind.

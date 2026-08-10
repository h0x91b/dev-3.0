# Repo-relative images in the markdown preview are swapped in the HTML, not in the DOM

## Context

The diff viewer's markdown preview (`MarkdownDocument`, `MarkdownRichDiff`) rendered
`![alt](docs/shot.png)` as a broken image: the webview's base URL is the app bundle
(or the remote server), never the checkout, so a repo-relative src cannot resolve.

## Investigation

The first implementation resolved the images by mutating the rendered `<img>` nodes in a
`useEffect` (remove `src`, read the file, set a data URL). Unit tests passed and it worked
after a manual re-mount, but on first open of the diff it silently did nothing. Browser
instrumentation showed the effect ran once with the right base dir and found all five
images, yet every node reported `isConnected === false` by the time the read resolved:
React had rebuilt that subtree from `dangerouslySetInnerHTML` and the effect did not
re-run, because its dependency (the HTML string) had not changed.

## Decision

`useDiskMarkdownImages` (`src/mainview/components/pr-review/markdown-images.ts`) takes the
rendered HTML, collects disk-backed `<img src>` values, resolves each to an absolute path
against the document's directory (root-relative ones against the worktree), reads it via
the existing `readFilePreview` RPC, and returns **new HTML** with the src replaced by a
data URL plus a `data-dev3-md-image` state marker. Resolution state lives in React state,
so every re-render keeps the resolved images. `MarkdownRichDiff` joins its blocks with a
NUL separator for one resolve pass and splits them back.

`readFilePreview` is reused deliberately: it already caps image size, maps the MIME type,
and gates the path to the home dir plus registered project roots — the same exposure class
as the terminal path preview, and it works identically in desktop and remote/browser mode.

## Risks

Data URLs are large; the module-level cache is capped at 24 entries and 40 images per
document. A file larger than the `readFilePreview` image cap renders as a missing
placeholder rather than an image.

## Alternatives considered

- Serving worktree files over a URL (custom `views://` protocol handler plus a remote HTTP
  route) — two transports to implement and secure for a preview-only feature.
- Keeping the DOM-mutation approach and forcing a re-run on every render — fights React for
  ownership of a subtree it rebuilds at will; that is the bug above.

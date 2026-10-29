# Artifacts in the browser: a shell frame owns the element picker

## Context
In the app, comment mode lets the user pick an element of an artifact and send a comment to the agent. In a browser tab there was no way to do that: the live page (`dev3 live url`) had no picker, and a static artifact opened as a bare `file://` page. The user asked for feedback on both kinds, with the picker and its modal belonging to the container around the page, never to the page, so an exported or downloaded artifact stays plain.

## Decision
The app's loopback live server (`src/bun/live-artifact-server.ts`) now serves a shell (`src/bun/artifact-browser-shell.ts`): a toolbar with Pick, the page in an iframe, and the feedback modal. `/<token>/` frames the live page at `_page`, and `/<token>/a/<artifactId>/<version>/` frames one static version. "Open in browser" on desktop goes there instead of `Utils.openPath`. The frame is same-origin, so the shell installs the viewer's own `installArtifactCommentTools` (moved to `src/shared/artifact-comment-script.ts`) into the frame from outside. Picks therefore produce the same selectors and pins as the app.

Comments go to `api/comment`. They are stored on `Task.review` anchored to the same `artifactId`/`version` the viewer uses (`live:<taskId>` v1 for the live page), in `src/bun/browser-artifact-comments.ts`. "Send" uses the same `<reviews>` prompt and marks the comment sent. The comment script gained a `widen` message (pick the parent) and now swallows presses while picking. The quick suggestions and Select parent step follow the user's Shenkar hub picker.

## Risks
The shell adds a 44 px bar above the page. Its strings are English only, because it is served HTML outside the renderer's i18n. Pins refresh after the user's own comment and on reload, not when the agent resolves one. In remote mode, "Open in browser" still gives a plain sandboxed link with no picker, because the loopback server is not reachable from the remote browser. A static page in the tab has no `window.dev3` bridge, same as the old `file://` tab. The server reads page paths from the task record, never from the renderer.

## Alternatives considered
- Inject the picker into the served page. It would be simpler, but the picker would ride inside the page, which the user ruled out.
- A separate picker implementation, like the Shenkar or Wixel admin ones. Rejected because its selectors would drift from the app's pins.

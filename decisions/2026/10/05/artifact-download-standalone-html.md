# Artifact download: standalone HTML first, ZIP only for attachments

## Context

`saveSharedArtifact` builds a ZIP whenever an artifact has any asset, and `loadSharedArtifactDownload` handed that ZIP over. The default template directory publishes its own `app.css`, `app.js`, `report.js` and `dev3-icon.png` as assets, so once the template became the default for every report, every download became a ZIP — even a text-only report.

## Decision

`planSharedArtifactDownload` in `src/bun/shared-artifacts.ts` folds the stored HTML with `inlineHtmlSource` (`src/shared/html-inline.ts`, the same engine as `dev3 inline-html`), reading only the artifact's own copied files. The download is that one HTML unless a file is a genuine attachment: video or audio (data-URI playback is unreliable in WebKit and unseekable), a file the page never embeds statically (a runtime-built path, an unreferenced file), or a file still referenced as a file after folding (`<a href="x.png" download>`). Then the ZIP built at publish is used. The ZIP is still written at publish time, so records published before this change get the new behaviour with no migration. `readArtifactContent` returns `downloadKind` so the button label matches.

## Risks

CDN `<script>`/`<link>` references stay links, so a standalone template report needs network for its charts, the same as the viewer. `srcset`, `poster` and module imports are not folded; such files fall back to the ZIP rather than being dropped. The leftover-reference check reads a name right after a quote, `(` or `=` as a reference; an over-match only costs a ZIP, never lost content.

## Alternatives considered

Deciding at publish time and storing the kind on the record would need a new field in `tasks.json` and leave every existing record wrong. Reusing `composeArtifactDocument` was rejected: it injects viewer-only channel, find and comment scripts that do not belong in a shared file. Inlining media into the HTML would make one file, but a page that may not play its own video is worse than a ZIP.

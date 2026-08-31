# Cap the Remote Access dialog against the viewport instead of letting it grow

## Context

The Remote Access modal grew one block at a time — interface picker, sign-in URL,
"Access code is on" (four paragraphs plus a copy button), the tunnel toggle with its
status line, stop button and propagation warning, and finally the exposed-ports list.
Its shell was a single `w-[28rem] p-6 space-y-4` div inside a centred flex backdrop
with no height cap, so once several of those blocks were live the dialog was taller
than the window: the heading was clipped at the top edge and the `Copy URL` / `Close`
row at the bottom, with nothing scrollable. Reported on a *wide* desktop window, so
every smaller screen was worse.

## Decision

`src/mainview/components/RemoteAccessDialog.tsx` is now a three-part shell: a pinned
`header`, a `min-h-0 flex-1 overflow-y-auto` body, and a pinned `footer`, inside
`max-h-full flex flex-col` with `p-4` on the backdrop. The dialog is `w-full
max-w-[28rem]` rather than a fixed `w-[28rem]`, so it also fits a 390px phone.
`src/mainview/App.tsx` passes the heading as `header` and the action row as `footer`;
the QR box is `QR_BOX_SIZE = "w-[min(14rem,26vh)] h-[min(14rem,26vh)]"` so it shrinks
on short windows instead of eating a fixed 224px; and the sign-in URL — which wrapped
over seven lines — is `line-clamp-2` with the full value in `title`, since the copy
button right beside it is how anyone actually transfers it.

Note `line-clamp-*` must not be combined with the `block` utility: Tailwind's `block`
wins the cascade over `display: -webkit-box` and the clamp silently does nothing.

## Risks

The body scrolls, so a block can now sit below the fold. Accepted: the alternative is
content off-screen with no way to reach it. The QR at `26vh` is 187px on a 720px-tall
window — still comfortably scannable, and it is the QR that made the fixed-height
version unfixable by scrolling alone.

## Alternatives considered

- **Scroll only, no QR shrink** — leaves a 224px QR on a 688px dialog; the scroll
  hides the problem rather than fixing the proportions.
- **Fold the access-code explanation behind a disclosure** — a new interaction and
  new copy in three locales for a block the scroll already handles.
- **Move the exposed-ports list to Settings** — that is a placement decision, not a
  layout one; handed back to the user as an option instead of being done here.

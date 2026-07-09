# 120 — Task-bound HTML artifacts

## Context

Agents can already surface raster output through `dev3 show-image`, but interactive reports had to be described in text or run as a separate web project. The new artifact must look native inside dev3, remain portable, support relative image assets, and work identically in Electrobun and remote/browser mode.

## Investigation

A full TSX/backend mini-runtime adds dependency installation, port lifecycle, sharing friction, and a much larger security boundary. A modal also blocks the terminal workflow, while `TaskWorkspacePane` already owns task-scoped alternate content and can host a docked sibling surface.

## Decision

`dev3 show-artifact` accepts one self-contained `.html` file plus optional `--images` assets from the HTML directory tree, preserves their safe relative paths inside an additive `shared-artifacts/<id>/` directory, and stores `Task.sharedArtifacts` alongside the untouched `sharedImages` field. The renderer uses an opaque-origin `iframe sandbox="allow-scripts"`, an injected restrictive CSP, and a stable namespaced dark/light token contract with a viewer-local Follow dev3/Light/Dark override; assets are data-URL rewritten only for display. Artifacts open in a pointer-captured, resizable right-side workspace with fullscreen, while downloads return HTML alone or a dependency-free STORE ZIP when images exist.

## Risks

Inline scripts are intentionally allowed for interactivity, so isolation depends on the sandbox remaining without `allow-same-origin`; CSP blocks connections and subresources, frames, objects, forms, and base URLs. Current browsers cannot forbid an allowed script from navigating its own iframe, so artifacts are trusted task output rather than an untrusted-code boundary. STORE ZIPs do not compress HTML, but raster assets are already compressed and avoiding a new runtime dependency keeps every update channel reliable.

## Alternatives considered

Rejected a bundled React/Express mini-app because it destroys single-file portability and duplicates dev-server lifecycle. Rejected merging Images and Artifacts into one inspector button because the user explicitly chose two separate conditional controls, accepting the Runtime-bar budget exception for clearer object identity.

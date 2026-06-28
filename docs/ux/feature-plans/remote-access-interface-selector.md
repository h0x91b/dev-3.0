# Feature plan — Remote Access: network-interface (IP) selector

## Summary
When the Cloudflare tunnel is **off**, let the user choose which local IPv4
address is encoded in the Remote Access QR + access URL, instead of the backend
silently auto-picking the first non-internal interface. The list includes every
non-internal interface address **and** loopback `127.0.0.1` (for SSH-forward /
same-machine use).

## Classification
- **Feature class:** configuration (focused, in-flow) with a diagnostic flavour
  (which network path reaches this machine).
- **Owning surface:** existing **Remote Access modal** (Modal surface in `App.tsx`,
  ~line 1529). NOT a new surface, nav destination, or toolbar control.
- **Scope:** session config (per open of the modal).
- **Frequency:** occasional/rare (set once when connecting).
- **Risk:** safe. Display-only — the server already binds `0.0.0.0`, so choosing a
  host changes only which URL/QR is shown, not what is reachable. Mildly
  security-adjacent (LAN IP vs localhost) but introduces no new exposure.

## Placement decision
- Put a compact **`<select>` directly above the URL code block**, under the QR +
  countdown. It controls the URL shown right below it and the QR above it, so it
  reads top-to-bottom: pick address → see URL → (optionally) flip to tunnel.
- **Visible only when the tunnel is OFF.** When the tunnel is connected/starting,
  the public `trycloudflare` URL is authoritative and interface choice is moot —
  hide the selector entirely (no disabled-but-present clutter).
- **Rejected placements:** (a) below the tunnel toggle — too far from the URL it
  controls; (b) a new settings page — it is ephemeral session config, not durable;
  (c) command palette — not a command.

## The control
- A **styled native `<select>`** — reuse the established pattern
  (`ProjectSettings.tsx:243`): `px-2 py-1.5 bg-elevated border border-edge
  rounded-lg text-fg text-xs outline-none focus:border-accent/40 transition-colors`.
  Native select is accessible (keyboard + SR) for free and renders identically in
  the Electrobun WKWebView and the headless browser. It is a form control, **not**
  a banned native OS dialog/menu.
- **Options:** one per candidate address, label = `‹iface› · ‹ip›`
  (e.g. `en0 · 172.16.38.86`). Loopback labelled `Localhost · 127.0.0.1`. Sorted:
  non-internal first (LAN/VPN), loopback last.
- **Label:** `text-fg-2 text-xs`, copy `remote.addressLabel` → "Reachable at".

## Interaction & states
- **Default selection:** the backend's current auto-pick (first non-internal IPv4),
  so behaviour is unchanged until the user touches it. If no non-internal IPv4
  exists, default to `127.0.0.1`.
- **On change:** rebuild URL + QR for the chosen host (re-request
  `getRemoteAccessQR({ tunnel, host })`), reset the refresh countdown.
- **On auto-refresh (every 25s):** preserve the selected host — pass it on each
  regeneration so the rotating token doesn't reset the address.
- **Tunnel toggled ON:** hide the selector; URL becomes the tunnel URL.
- **Tunnel toggled OFF:** selector reappears with the last/auto selection.
- **Selection is session-local** (modal state). Not persisted in v1; optional
  future enhancement: remember the last choice in `localStorage`.

## Tokens / roles
- Neutral config control — no primary/secondary/destructive role.
- `bg-elevated` + `border-edge` + `text-fg`; focus `border-accent/40`. No new tokens.

## Backend (separate from UI, summarised here)
- Enumerate addresses server-side via `os.networkInterfaces()` (browser can't see
  host interfaces). Return `interfaces: [{ name, address, internal }]` including
  loopback `127.0.0.1`.
- `getAccessUrl(host?)` / `generateQrDataUrl(host?)` accept an optional host; when
  a tunnel is connected the tunnel URL wins and host is ignored.
- **Validate** the requested host against the enumerated allow-list; fall back to
  auto if it isn't a known address (no arbitrary host injection into the URL).

## Accessibility
- Native `<select>` + associated `<label>`/`aria-label`. Keyboard and screen-reader
  handled by the platform.

## i18n
- New keys (en/ru/es): `remote.addressLabel` ("Reachable at"), and a `remote.localhostHint`
  suffix for the loopback option if desired.

## Manifest impact
- None structural — a config control inside an existing modal. No new object,
  route, surface, or token. Recorded as a UX decision; no `ux-architecture.yaml`
  schema change.

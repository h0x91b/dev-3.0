# A custom provider's stored label never changes; a rename goes into displayName

## Context
A custom provider's proxy key is `custom-<slug of label>`, and agents persist wire names `<key>/<model>`. Renaming the label changed the key and every running agent got 403. `~/.dev3.0/model-catalog.json` is shared with older installed app versions, which read only `id/kind/label/baseUrl/apiFormat/usageSource`, derive the key from `label`, and drop unknown fields on their next save.

## Decision
The on-disk `label` of a custom provider is frozen at first save: it is the routing identity every version derives the key from. A rename is stored in the optional `displayName` (`keepProviderRoutingLabels`, `src/shared/model-catalog.ts`, called by `modelCatalogSave`). The view shows `providerDisplayName` as `label` and carries the real key as a view-only `wireKey` computed by `toView`; the renderer never sends either back as trusted. Display-only code uses `providerDisplayName`; key code keeps using `sidecarProviderKey`.

## Risks
An older version that re-saves the file drops `displayName`, so the old name reappears; routing is unaffected. Two providers can end up with a frozen key equal to another's label-derived key; `validateCatalog` rejects that save and the renderer avoids it in `uniqueCustomProviderLabel`.

## Alternatives considered
- A persisted `wireKey`: older versions drop it on save and derive the key from the renamed label again.
- Aliases in the sidecar config for old keys: older versions rebuild their own config without them, and it keeps dead names routable.

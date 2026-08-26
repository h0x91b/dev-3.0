Short: Artifact images built by script now load

Images an artifact report builds from JavaScript now load in the in-app viewer instead of
silently breaking, both through the new `dev3Artifact.asset()` helper and for reports
published before it existed. The starter's chart bridge now names the fix when it is handed
an element id instead of an element, or an option object passed to `update()`/`remount()`,
and `AUTHORING.md` shows the exact `rgb(var(--dev3-token) / a)` colour form and the
`chart()` signature that used to be described only in prose.

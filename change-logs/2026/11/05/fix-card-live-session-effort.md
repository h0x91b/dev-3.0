Short: Card shows in-session effort and model

A running Claude task card now shows the effort or model the session actually runs with after `/effort` or `/model` changes it, next to the preset it was launched with (read from the statusLine dump, so it needs rate-limit tracking on). Agents with no live signal keep showing the launch preset.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2180)

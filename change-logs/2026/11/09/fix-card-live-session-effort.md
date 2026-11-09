Short: Card shows in-session effort and model

A running Claude task card now shows the effort or model the session actually runs with after `/effort` or `/model` changes it, as a small marker next to the preset it was launched with. It is read from the statusLine dump, so it needs rate-limit tracking on; other agents keep showing the launch preset, and the marker clears as soon as the agent exits.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2180)
Contributed by @Prasad8830 (h0x91b/dev-3.0#2226)

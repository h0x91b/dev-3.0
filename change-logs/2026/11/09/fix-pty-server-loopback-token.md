Short: Terminal port closed to the network

The internal terminal server now listens on this machine only and requires a per-launch access token, so nobody else on your network can attach to an agent's terminal; before, it answered on every interface and a task id was enough. Remote access works as before: LAN, tunnel and SSH browsers reach terminals through the signed-in remote server. Opening the app over a plain http LAN address no longer crashes on start.

Suggested by @genrym (h0x91b/dev-3.0#2200)

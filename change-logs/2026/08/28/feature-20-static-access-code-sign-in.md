Short: Sign in with a permanent access code

The remote-access static code is now a proper long-lived credential: it is typed on a browser sign-in screen instead of riding in the URL, it works alongside QR sign-in rather than replacing it, and you can set it in Settings → System instead of only through an environment variable. `dev3 remote --static-code=…` now starts with a warning about public-tunnel reach instead of refusing to boot.

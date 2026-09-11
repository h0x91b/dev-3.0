Short: Load API models without starting the proxy

"Load available models" in Settings → API models no longer waits for you to start the model proxy by hand — the backend already starts it on demand, so the button now only needs a saved provider, shows that it is working while the proxy comes up, and stays clickable to retry after a failure. The stopped-proxy status line no longer claims dev3 started it with the app; it says the proxy starts itself when an agent needs it or when you load the model list.

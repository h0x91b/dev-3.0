Short: Restore browser notification setup

Include all built public assets in CLI release archives, fixing browser notification setup when the missing service worker was served as HTML. Packaging now fails if a public asset is missing from the Vite output.

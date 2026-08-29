Short: Web Push works in packaged builds

Web Push could never enrol in a packaged build: `sw.js` and `manifest.webmanifest` were missing from the app bundle, so the service worker was served as HTML and refused to register. Every file in the renderer's public folder is now packaged automatically. The remote-access port can also be pinned in Settings → System instead of only through an environment variable a Finder launch never sees, and a custom tunnel's log lines are attributed to the tool that printed them rather than to the wrapper that echoed its hostname.

Short: Artifact popup no longer painted over

HTML artifacts render inside the app window again instead of in a separate native webview layer, which could paint an opaque rectangle over the artifact popup and over menus and toasts drawn on top of it. The transport picker and the overlay-mask machinery that layer needed are gone; find, theme, image saving, downloads, version switching and sending a form back to the agent all work exactly as before, and remote (browser) mode is unchanged.

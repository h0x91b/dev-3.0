Fixed "app is damaged" error on signed builds by setting COPYFILE_DISABLE=1 to prevent macOS from creating AppleDouble ._ files inside the app bundle, which invalidate code signatures.

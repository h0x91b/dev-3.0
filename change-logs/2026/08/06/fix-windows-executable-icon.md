Short: Windows builds get their app icon

Windows executables shipped with the blank default icon because electrobun's bundled CLI cannot resolve its own `rcedit` dependency and swallowed the failure as a warning. The app icon is now embedded by the build itself and verified by reading the icon resource back out of `launcher.exe` and `bun.exe`, so a silent failure fails the packaging build instead of shipping.

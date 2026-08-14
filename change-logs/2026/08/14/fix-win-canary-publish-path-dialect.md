Short: Windows canary builds publish again

Fixed the win-x64 canary publish, which failed on its first ever run: the release script built an absolute module path under Git Bash (`/d/a/...`) and handed it to bun, which on Windows resolves only `D:\a\...`. The canary version suffix is now computed with a cwd-relative import, and the publish path is exercised on a real Windows runner in the packaged Windows proof so a macOS-only pass can no longer stand in for it.

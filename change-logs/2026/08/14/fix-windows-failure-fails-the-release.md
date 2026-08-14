Short: Windows failures now block the release

From now on a broken Windows build blocks the entire release, including the macOS disk images: the win-x64 leg is no longer best-effort, `release-build-windows.yml` lost its `bestEffort` input and `continue-on-error` altogether, and the release job's "Warn when the Windows build is missing" step is deleted because a missing Windows zip can no longer happen. The Linux legs keep their own best-effort semantics unchanged, and the canary channel was already fail-closed.

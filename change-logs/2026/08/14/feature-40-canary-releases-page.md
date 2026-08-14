Short: Canary builds on the releases page

Canary builds are now downloadable from the GitHub releases page: one rolling pre-release tagged `canary`, refreshed on every publish, carrying the macOS DMGs, the Linux tarballs, the CLI tarballs and the launched Windows zip. It is always a pre-release and never "Latest", so the stable release keeps the badge and every `/releases/latest` link keeps resolving to it. Each file's row names the run that produced those exact bytes, and the in-app updater still reads the S3 feed — nothing about updates changed.

Added missing `release.baseUrl` to `electrobun.config.ts`. The built-in `Updater.downloadUpdate()` needs this URL to construct download paths — without it, the fetch fails with `ERR_INVALID_URL`.

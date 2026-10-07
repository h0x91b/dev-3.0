# Release feed behind CloudFront, canary archive trimmed to CLI tarballs

## 1. Context

`h0x91b-releases` served every download straight from S3: ~442 GB of egress in September 2026 (~$31 of a ~$49 bill), with storage growing ~200 GB a month, ~90% of it per-commit canary archives (`dev-3.0/<sha>/`, ~1.6 GB each, 4–5 a day).

## 2. Investigation

- The feed URL is baked into every bundle (electrobun `release.baseUrl` → `version.json`), so an installed client polls the host it was built with until it updates — and forever if it never does.
- CloudFront bills every byte it serves, cache hit or miss; fetching from an S3 origin is free; pay-as-you-go includes 1 TB and 10M requests a month (pricing pages, 2026-10-06). Caching therefore buys latency, not money.
- `dev-3.0/<sha>/` is NOT a pure archive: headless `dev3 update` on canary downloads `<sha of the current manifest>/dev3-cli-*.tar.gz` (`tarballUrl()` in `src/shared/self-update.ts`). Nothing reads the DMGs, zips or `.tar.zst` there — the desktop feed is the bucket root and humans get canary from the rolling GitHub pre-release.

## 3. Decision

- `RELEASE_BASE_URL` in `src/shared/release-feed.ts` is the only spelling of the public feed URL: `https://releases.h0x91b.com/dev-3.0`, a CloudFront distribution (`E16JT0UW6SYCTS`) with an OAC origin on the bucket. A custom hostname rather than `*.cloudfront.net` so the CDN can change later with a DNS edit instead of another permanently-baked URL. `release-feed.test.ts` fails on any direct bucket URL in `src/`, `scripts/` or the workflows.
- The bucket keeps its public-read policy: every build before this one polls S3 directly. Uploads stay on `s3://`.
- Cache behaviors: `dev-3.0/*-update.json`, `dev-3.0/canary-*`, `dev-3.0/stable-*` (the mutable root feed) are `Managed-CachingDisabled` — caching a same-named, overwritten `.tar.zst` could pair a new manifest with an old bundle. Versioned dirs use `Managed-CachingOptimized` (1 day; a re-run of a release overwrites them).
- Canary archives keep only `dev3-cli-*.tar.gz` (macOS, Linux); Windows writes no canary archive because it ships no CLI tarball.
- Retention (follow-up): a sweeper tags every dir that no current manifest references `superseded`; a lifecycle rule expires tagged canary objects after 7 days and stable `v*` after 90. Untagged objects are never expired, so the current build of either channel survives however old it is.

## 4. Risks

- If `h0x91b.com` lapses, every client built after this change stops updating. The bucket URL keeps older builds alive.
- Above 1 TB a month CloudFront costs $0.085/GB — cheaper than S3's $0.09, not free. A flat-rate CloudFront plan must not be attached: its free tier is 100 GB.

## 5. Alternatives considered

- `dXXXX.cloudfront.net`: no DNS or certificate, but permanently binds clients to one distribution — the same trap as the baked S3 URL.
- A separate canary prefix with a plain 7-day prefix expiration: breaks the `<sha>/` path installed CLIs use and still deletes the current build when `main` is idle for a week.
- Caching the root feed with invalidation on publish: same cost, more moving parts, and a race between bundle and manifest.

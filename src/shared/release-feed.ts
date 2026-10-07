/**
 * Public base URL of the release feed: update manifests, desktop bundles, CLI tarballs.
 * It is the CloudFront distribution in front of `s3://h0x91b-releases/dev-3.0/`; CI still uploads
 * to the bucket. Every build bakes this into its bundle, so installed clients keep polling the URL
 * they were built with — the bucket must stay publicly readable. See the
 * `release-feed-behind-cloudfront` decision record.
 */
export const RELEASE_BASE_URL = "https://releases.h0x91b.com/dev-3.0";

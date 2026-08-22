#!/usr/bin/env bash
# Runs `bun install` with a bounded, LOUD retry.
#
# The registry intermittently serves a truncated tarball ("Fail extracting tarball
# for <pkg>"), which fails an unrelated PR and costs a human a rerun. A retry cannot
# tell that apart from a genuinely broken lockfile, so it never hides a failure — a
# real one simply fails a few seconds later, after every attempt is spent.
#
# A retry is only worth anything if the rate stays visible, so every retry is
# announced as a workflow warning and written to the run summary.
set -uo pipefail

attempts="${BUN_INSTALL_ATTEMPTS:-3}"
# Space-separated seconds to sleep before attempt 2, 3, ... Tests set this to 0.
delays="${BUN_INSTALL_RETRY_DELAYS:-5 15}"
read -r -a delay_list <<<"$delays"

note() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "=== bun install ${*:-} (attempt $attempt/$attempts) ==="
  if bun install "$@"; then
    if [ "$attempt" -gt 1 ]; then
      echo "::warning title=bun install retried::bun install succeeded only on attempt $attempt of $attempts — the registry failed $((attempt - 1)) time(s) on this job"
      note "⚠️ \`bun install\` needed $attempt attempts (registry failed $((attempt - 1)) time(s))"
    fi
    exit 0
  fi

  if [ "$attempt" -lt "$attempts" ]; then
    delay="${delay_list[attempt - 1]:-15}"
    echo "::warning title=bun install failed::attempt $attempt/$attempts failed; retrying in ${delay}s"
    # A failed extraction can leave a half-written tree and a corrupt cache entry,
    # so the retry starts from nothing rather than re-reading the same bad tarball.
    rm -rf node_modules
    bun pm cache rm || true
    sleep "$delay"
  fi
done

echo "::error title=bun install failed::all $attempts attempts failed — this is not a transient registry blip, look at the last attempt's output"
note "❌ \`bun install\` failed all $attempts attempts"
exit 1

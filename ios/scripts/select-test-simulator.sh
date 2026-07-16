#!/usr/bin/env bash

set -euo pipefail

simulator_udid="$({
	xcrun simctl list devices available --json
} | jq -r '
[
  .devices
  | to_entries[]
  | select(.key | test("SimRuntime\\.iOS-[0-9]+-[0-9]+$"))
  | (.key | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)$")) as $version
  | .value[]
  | select(.name | startswith("iPhone"))
  | {
      major: ($version.major | tonumber),
      minor: ($version.minor | tonumber),
      name,
      udid
    }
]
| sort_by(-.major, -.minor, .name, .udid)
| first
| .udid // empty
')"

if [[ -z "$simulator_udid" ]]; then
	echo "No available iPhone Simulator was found." >&2
	exit 1
fi

printf '%s\n' "$simulator_udid"

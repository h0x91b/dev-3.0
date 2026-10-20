#!/bin/bash
set -uo pipefail

# Prints the first file matching */<suffix> under the given roots, searched in order.
# Usage: ./scripts/find-shipped-app-file.sh <suffix> <root> [<root>...]
#
# Exit codes: 0 found (path on stdout), 1 not found, 2 the search itself failed.
#
# A root that does not exist is SKIPPED, not an error. The release gates pass the
# extracted self-extractor payload first and ./build second, and the payload root only
# exists when electrobun got as far as packing it: when `stapler staple` fails, the full
# inner .app is left in ./build with no payload. `find <missing> ./build | head -1` under
# pipefail then fails the step with no message even though ./build had the file.
# A real search error on a root that DOES exist still fails, loudly.

SUFFIX="${1:?Usage: $0 <suffix> <root> [<root>...]}"
shift
if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <suffix> <root> [<root>...]" >&2
  exit 2
fi

SEARCHED=()
for ROOT in "$@"; do
  if [ ! -e "$ROOT" ]; then
    echo "skipping $ROOT (does not exist)" >&2
    continue
  fi
  SEARCHED+=("$ROOT")
  ERR_FILE=$(mktemp)
  FOUND=$(find "$ROOT" -path "*/$SUFFIX" -type f 2>"$ERR_FILE")
  CODE=$?
  ERR=$(cat "$ERR_FILE")
  rm -f "$ERR_FILE"
  if [ "$CODE" -ne 0 ]; then
    echo "::error::searching $ROOT for $SUFFIX failed (find exit $CODE): $ERR" >&2
    exit 2
  fi
  if [ -n "$FOUND" ]; then
    echo "${FOUND%%$'\n'*}"
    exit 0
  fi
done

if [ "${#SEARCHED[@]}" -eq 0 ]; then
  echo "::error::no $SUFFIX found: none of the search roots exist ($*)" >&2
else
  echo "::error::no $SUFFIX found under: ${SEARCHED[*]}" >&2
fi
exit 1

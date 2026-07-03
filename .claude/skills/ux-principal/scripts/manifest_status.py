#!/usr/bin/env python3
"""Check whether expected UX manifest files exist and print a compact status."""
from __future__ import annotations

import argparse
from pathlib import Path
from datetime import datetime, timezone

EXPECTED = [
    "docs/ux/PRODUCT_UX_BIBLE.md",
    "docs/ux/ux-architecture.yaml",
    "docs/ux/UX_DECISIONS.md",
    "docs/ux/UX_MANIFEST_CHANGELOG.md",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    print(f"UX manifest status for {root}")
    missing = []
    for rel in EXPECTED:
        path = root / rel
        if path.exists():
            stat = path.stat()
            updated = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")
            print(f"OK      {rel} ({stat.st_size} bytes, updated {updated} UTC)")
        else:
            missing.append(rel)
            print(f"MISSING {rel}")
    if missing:
        print("\nRecommended: run ux-create-manifest before feature planning.")
        return 2
    print("\nRecommended: read the manifest files before making UX placement decisions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

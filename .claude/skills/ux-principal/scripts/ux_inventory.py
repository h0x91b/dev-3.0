#!/usr/bin/env python3
"""
Generate a lightweight UX inventory for a frontend repository.

This script is intentionally heuristic. It helps an agent discover routes,
components, actions, and design tokens, but it does not replace manual review.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

IGNORE_DIRS = {
    ".git", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit",
    "coverage", ".cache", "vendor", "target", "out", ".turbo", ".vercel"
}
TEXT_EXTS = {
    ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".html",
    ".css", ".scss", ".sass", ".less", ".md", ".mdx", ".json", ".yaml", ".yml"
}
ROUTE_HINTS = ["app", "pages", "routes", "src/app", "src/pages", "src/routes"]
KEYWORDS = {
    "navigation": ["nav", "navigation", "sidebar", "menu", "breadcrumb", "tabs", "tabbar"],
    "actions": ["button", "toolbar", "action", "dropdown", "contextmenu", "bulk", "export", "delete", "archive", "create"],
    "surfaces": ["modal", "dialog", "drawer", "sheet", "popover", "toast", "inspector", "panel", "command"],
    "tables": ["table", "grid", "data-table", "datatable", "columns"],
    "forms": ["form", "input", "select", "textarea", "checkbox", "radio", "submit"],
    "states": ["empty", "loading", "skeleton", "error", "notfound", "forbidden", "unauthorized"],
    "tokens": ["theme", "token", "variant", "primary", "secondary", "destructive", "danger", "success", "warning", "accent"],
}


def iter_files(root: Path, max_file_kb: int) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix.lower() not in TEXT_EXTS:
                continue
            try:
                if path.stat().st_size > max_file_kb * 1024:
                    continue
            except OSError:
                continue
            yield path


def rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def classify_files(files: List[Path], root: Path) -> Dict[str, List[str]]:
    buckets: Dict[str, List[str]] = defaultdict(list)
    for p in files:
        r = rel(p, root)
        low = r.lower()
        for bucket, words in KEYWORDS.items():
            if any(w in low for w in words):
                buckets[bucket].append(r)
        if any(low.startswith(h + "/") or f"/{h}/" in low for h in ROUTE_HINTS):
            if any(p.name.startswith(x) for x in ["page.", "route.", "layout.", "index."]) or p.suffix.lower() in {".tsx", ".jsx", ".vue", ".svelte", ".astro"}:
                buckets["route_candidates"].append(r)
    return {k: sorted(v)[:250] for k, v in buckets.items()}


def extract_variants(text: str) -> List[str]:
    variants = set()
    patterns = [
        r"variant\s*[:=]\s*[\"']([a-zA-Z0-9_-]+)[\"']",
        r"variants\s*[:=]\s*\{([^}]{0,1000})\}",
        r"class-variance-authority|cva\(",
    ]
    for m in re.finditer(patterns[0], text):
        variants.add(m.group(1))
    for m in re.finditer(patterns[1], text, flags=re.S):
        block = m.group(1)
        for key in re.findall(r"([a-zA-Z0-9_-]+)\s*:", block):
            variants.add(key)
    return sorted(variants)


def inspect_content(files: List[Path], root: Path) -> Dict[str, object]:
    symbols = defaultdict(list)
    variants = defaultdict(list)
    route_labels = []
    menu_literals = []
    action_literals = []
    semantic_tokens = defaultdict(list)

    button_re = re.compile(r"<Button\b|buttonVariants|variant=|<button\b", re.I)
    route_re = re.compile(r"(?:path|href|to)\s*=\s*[\"']([^\"']+)[\"']")
    label_re = re.compile(r"(?:label|title|name)\s*[:=]\s*[\"']([^\"']{2,60})[\"']")
    action_re = re.compile(r"\b(Create|Add|New|Edit|Save|Delete|Remove|Archive|Export|Import|Invite|Enable|Disable|Reset|Cancel|Apply|Run|Open|View|Manage)\b")
    token_re = re.compile(r"\b(primary|secondary|destructive|danger|warning|success|info|accent|muted|neutral|ghost|outline)\b", re.I)

    for p in files:
        txt = read_text(p)
        if not txt:
            continue
        r = rel(p, root)
        low = r.lower()
        if button_re.search(txt):
            symbols["button_usage"].append(r)
        if any(x in low for x in ["button", "badge", "theme", "token", "tailwind", "ui/"]):
            vs = extract_variants(txt)
            if vs:
                variants[r] = vs[:40]
        for m in route_re.finditer(txt):
            val = m.group(1)
            if val.startswith("/") and len(val) < 120:
                route_labels.append({"file": r, "route": val})
        for m in label_re.finditer(txt):
            val = m.group(1)
            if len(val.strip()) >= 2:
                menu_literals.append({"file": r, "label": val.strip()})
        for m in action_re.finditer(txt):
            action_literals.append({"file": r, "action": m.group(1)})
        toks = sorted(set(t.group(1).lower() for t in token_re.finditer(txt)))
        if toks:
            semantic_tokens[r] = toks[:30]

    return {
        "button_usage_files": sorted(set(symbols["button_usage"]))[:250],
        "variant_definitions": dict(list(variants.items())[:100]),
        "route_references": route_labels[:250],
        "label_literals": menu_literals[:250],
        "action_literals": action_literals[:250],
        "semantic_token_mentions": dict(list(semantic_tokens.items())[:150]),
    }


def package_info(root: Path) -> Dict[str, object]:
    data = {}
    package = root / "package.json"
    if package.exists():
        try:
            pkg = json.loads(package.read_text(encoding="utf-8"))
            deps = {}
            for key in ["dependencies", "devDependencies"]:
                deps.update(pkg.get(key, {}))
            frameworks = [name for name in deps if name in {
                "next", "react", "react-router", "@remix-run/react", "vue", "nuxt", "svelte", "@sveltejs/kit",
                "@angular/core", "tailwindcss", "@mui/material", "antd", "@chakra-ui/react", "@radix-ui/react-dialog",
                "lucide-react", "framer-motion"
            }]
            data["package_name"] = pkg.get("name")
            data["framework_hints"] = frameworks
            data["scripts"] = pkg.get("scripts", {})
        except Exception as exc:
            data["package_error"] = str(exc)
    return data


def write_markdown(out_dir: Path, inventory: Dict[str, object]) -> None:
    lines = ["# Generated UX Inventory", "", "This file is generated by `ux_inventory.py`. Review manually before using it as manifest evidence.", ""]
    pkg = inventory.get("package", {})
    if pkg:
        lines += ["## Package", "", "```json", json.dumps(pkg, indent=2, ensure_ascii=False), "```", ""]
    for key in ["classified_files", "content_findings"]:
        lines += [f"## {key.replace('_', ' ').title()}", "", "```json", json.dumps(inventory.get(key, {}), indent=2, ensure_ascii=False), "```", ""]
    (out_dir / "ux-inventory.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="Repository root")
    parser.add_argument("--out", default="docs/ux/generated/ux-inventory", help="Output directory")
    parser.add_argument("--max-file-kb", type=int, default=256)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = root / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    files = list(iter_files(root, args.max_file_kb))
    inventory = {
        "root": str(root),
        "file_count_scanned": len(files),
        "package": package_info(root),
        "classified_files": classify_files(files, root),
        "content_findings": inspect_content(files, root),
    }

    (out_dir / "ux-inventory.json").write_text(json.dumps(inventory, indent=2, ensure_ascii=False), encoding="utf-8")
    write_markdown(out_dir, inventory)
    print(f"Wrote {out_dir / 'ux-inventory.json'}")
    print(f"Wrote {out_dir / 'ux-inventory.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

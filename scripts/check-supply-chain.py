#!/usr/bin/env python3
"""Read-only scan for known npm supply-chain incident indicators.

This scanner is intentionally conservative:
- It only reads files and directory names.
- It does not install, remove, or modify dependencies.
- It exits non-zero when it finds known affected package families or IOCs.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


MANIFEST_FILE_NAMES = {
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}

SKIP_DIR_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".turbo",
    "coverage",
    "dist",
    "build",
}

SCOPED_PACKAGE_PREFIXES = [
    "@tanstack/",
    "@mistralai/",
    "@opensearch-project/",
    "@uipath/",
    "@cap-js/",
    "@beproduct/",
    "@dirigible-ai/",
    "@draftauth/",
    "@draftlab/",
    "@mesadev/",
    "@ml-toolkit-ts/",
    "@squawk/",
    "@supersurkhet/",
    "@tallyui/",
]

PACKAGE_NAMES = [
    "agentwork-cli",
    "cmux-agent-mcp",
    "cross-stitch",
    "git-branch-selector",
    "git-git-git",
    "intercom-client",
    "mbt",
    "nextmove-mcp",
    "plain-crypto-js",
    "safe-action",
    "ts-dna",
    "wot-api",
]

IOC_TOKENS = [
    "router_init.js",
    "filev2.getsession.org",
    "seed1.getsession.org",
    "seed2.getsession.org",
    "seed3.getsession.org",
]


@dataclass(frozen=True)
class Finding:
    category: str
    location: str
    detail: str


@dataclass(frozen=True)
class TokenPattern:
    label: str
    pattern: re.Pattern[str]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only scan for known npm supply-chain attack package names and IOCs."
    )
    parser.add_argument(
        "--root",
        default=Path(__file__).resolve().parents[1],
        help="Primary scan root. Defaults to the repository root.",
    )
    parser.add_argument(
        "--path",
        action="append",
        default=[],
        help="Additional scan root. Can be passed multiple times.",
    )
    parser.add_argument(
        "--scan-npm-home",
        action="store_true",
        help="Also scan ~/.npm/_logs and ~/.npm/_cacache/index-v5 if they exist.",
    )
    return parser


def build_package_patterns() -> list[TokenPattern]:
    patterns: list[TokenPattern] = []
    for prefix in SCOPED_PACKAGE_PREFIXES:
        patterns.append(
            TokenPattern(
                label=prefix,
                pattern=re.compile(re.escape(prefix) + r"[A-Za-z0-9._-]+", re.IGNORECASE),
            )
        )
    for name in PACKAGE_NAMES:
        patterns.append(
            TokenPattern(
                label=name,
                pattern=re.compile(r"(?<![A-Za-z0-9._-])" + re.escape(name) + r"(?![A-Za-z0-9._-])", re.IGNORECASE),
            )
        )
    return patterns


PACKAGE_PATTERNS = build_package_patterns()


def unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[Path] = set()
    ordered: list[Path] = []
    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(resolved)
    return ordered


def read_text_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []


def format_line_hit(token: str, line_number: int, line: str) -> str:
    excerpt = " ".join(line.strip().split())
    excerpt = excerpt[:180]
    return f"{token} on line {line_number}: {excerpt}"


def scan_text_file(path: Path, tokens: list[str], category: str) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(read_text_lines(path), start=1):
        lowered = line.lower()
        for token in tokens:
            if token.lower() in lowered:
                findings.append(
                    Finding(
                        category=category,
                        location=str(path),
                        detail=format_line_hit(token, line_number, line),
                    )
                )
    return findings


def scan_text_file_patterns(path: Path, patterns: list[TokenPattern], category: str) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(read_text_lines(path), start=1):
        for token in patterns:
            match = token.pattern.search(line)
            if not match:
                continue
            findings.append(
                Finding(
                    category=category,
                    location=str(path),
                    detail=format_line_hit(token.label, line_number, line),
                )
            )
    return findings


def inspect_node_modules_dir(node_modules_dir: Path) -> list[Finding]:
    findings: list[Finding] = []
    for token in SCOPED_PACKAGE_PREFIXES:
        if token.startswith("@"):
            scope_name, _, package_prefix = token.partition("/")
            scope_dir = node_modules_dir / scope_name
            if not scope_dir.is_dir():
                continue
            if package_prefix:
                for child in sorted(scope_dir.iterdir()):
                    if child.is_dir() and child.name.startswith(package_prefix):
                        findings.append(
                            Finding(
                                category="node_modules",
                                location=str(child),
                                detail=f"installed scoped package matched {token}",
                            )
                        )
    for token in PACKAGE_NAMES:
        package_dir = node_modules_dir / token
        if package_dir.is_dir():
            findings.append(
                Finding(
                    category="node_modules",
                    location=str(package_dir),
                    detail=f"installed package matched {token}",
                )
            )
    return findings


def walk_scan_roots(scan_roots: list[Path]) -> tuple[list[Finding], int, int]:
    findings: list[Finding] = []
    manifest_count = 0
    node_modules_count = 0

    for root in scan_roots:
        if not root.exists():
            findings.append(Finding("warning", str(root), "path does not exist"))
            continue
        for current_root, dir_names, file_names in os.walk(root):
            filtered_dirs: list[str] = []
            current_path = Path(current_root)
            for dir_name in dir_names:
                if dir_name in SKIP_DIR_NAMES:
                    continue
                if dir_name == "node_modules":
                    node_modules_count += 1
                    findings.extend(inspect_node_modules_dir(current_path / dir_name))
                    continue
                filtered_dirs.append(dir_name)
            dir_names[:] = filtered_dirs

            for file_name in file_names:
                if file_name not in MANIFEST_FILE_NAMES and file_name != "router_init.js":
                    continue
                manifest_count += 1
                file_path = current_path / file_name
                findings.extend(scan_text_file_patterns(file_path, PACKAGE_PATTERNS, "manifest"))
                findings.extend(scan_text_file(file_path, IOC_TOKENS, "ioc"))

    return findings, manifest_count, node_modules_count


def scan_npm_home() -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    file_count = 0
    npm_home = Path.home() / ".npm"
    extra_roots = [
        npm_home / "_logs",
        npm_home / "_cacache" / "index-v5",
    ]

    for root in extra_roots:
        if not root.exists():
            continue
        for current_root, dir_names, file_names in os.walk(root):
            dir_names[:] = [name for name in dir_names if name not in SKIP_DIR_NAMES]
            current_path = Path(current_root)
            for file_name in file_names:
                file_path = current_path / file_name
                if not file_path.is_file():
                    continue
                file_count += 1
                findings.extend(scan_text_file_patterns(file_path, PACKAGE_PATTERNS, "npm-home"))
                findings.extend(scan_text_file(file_path, IOC_TOKENS, "npm-home"))

    return findings, file_count


def print_summary(
    scan_roots: list[Path],
    findings: list[Finding],
    manifest_count: int,
    node_modules_count: int,
    npm_home_file_count: int,
    scanned_npm_home: bool,
) -> int:
    print("Supply-chain scan targets:")
    for root in scan_roots:
        print(f"- {root}")
    if scanned_npm_home:
        print(f"- {Path.home() / '.npm'}")

    print("")
    print(f"Scanned manifest/lock files: {manifest_count}")
    print(f"Inspected node_modules directories: {node_modules_count}")
    if scanned_npm_home:
        print(f"Scanned npm home files: {npm_home_file_count}")

    real_findings = [finding for finding in findings if finding.category != "warning"]
    warnings = [finding for finding in findings if finding.category == "warning"]

    if warnings:
        print("")
        for warning in warnings:
            print(f"[WARN] {warning.location}: {warning.detail}")

    if not real_findings:
        print("")
        print("[OK] No known affected package names or incident IOCs were found.")
        return 0

    print("")
    for finding in real_findings:
        print(f"[HIT] {finding.category} {finding.location}: {finding.detail}")

    print("")
    print(f"[FAIL] Found {len(real_findings)} possible incident matches.")
    return 1


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    scan_roots = unique_paths([Path(args.root), *(Path(path) for path in args.path)])
    findings, manifest_count, node_modules_count = walk_scan_roots(scan_roots)

    npm_home_file_count = 0
    if args.scan_npm_home:
        npm_findings, npm_home_file_count = scan_npm_home()
        findings.extend(npm_findings)

    return print_summary(
        scan_roots=scan_roots,
        findings=findings,
        manifest_count=manifest_count,
        node_modules_count=node_modules_count,
        npm_home_file_count=npm_home_file_count,
        scanned_npm_home=args.scan_npm_home,
    )


if __name__ == "__main__":
    sys.exit(main())

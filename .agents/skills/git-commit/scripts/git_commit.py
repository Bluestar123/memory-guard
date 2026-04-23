#!/usr/bin/env python3
"""
Generate a short commit message from local git changes and optionally commit them.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
DEFAULT_MAX_LENGTH = 72
DEFAULT_MODEL = os.environ.get("ASKQUESTION_MODEL", "askquestion")
NOISY_TOKENS = {
    "src",
    "lib",
    "index",
    "main",
    "test",
    "tests",
    "spec",
    "cargo",
    "package",
    "lock",
    "json",
    "toml",
    "tsx",
    "ts",
    "js",
    "mjs",
    "rs",
    "md",
    "github",
    "workflow",
    "workflows",
}


def run_git(args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=check,
        capture_output=True,
        text=True,
    )


def git_output(args: list[str]) -> str:
    return run_git(args).stdout.strip()


def ensure_repo() -> None:
    try:
        git_output(["rev-parse", "--show-toplevel"])
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.stderr.strip() or "Not inside a git repository.") from exc


def has_staged_changes() -> bool:
    return bool(git_output(["diff", "--cached", "--name-only"]))


def has_unstaged_changes() -> bool:
    return bool(git_output(["diff", "--name-only"]))


def resolve_mode(requested: str) -> str:
    if requested != "auto":
        return requested
    if has_staged_changes():
        return "staged"
    if has_unstaged_changes():
        return "unstaged"
    return "all"


def diff_args(mode: str) -> list[str]:
    if mode == "staged":
        return ["diff", "--cached"]
    if mode == "unstaged":
        return ["diff"]
    if mode == "all":
        return ["diff", "HEAD"]
    raise ValueError(f"Unsupported mode: {mode}")


def name_only(mode: str) -> list[str]:
    output = git_output(diff_args(mode) + ["--name-only"])
    files = [line for line in output.splitlines() if line]
    if files:
        return files

    if mode in {"unstaged", "all"}:
        untracked = []
        for line in status_lines():
            if line.startswith("?? "):
                untracked.append(line[3:])
        if untracked:
            return untracked

    return []


def diff_stat(mode: str) -> str:
    return git_output(diff_args(mode) + ["--stat"])


def diff_text(mode: str) -> str:
    return git_output(diff_args(mode) + ["--unified=1", "--no-color"])


def status_lines() -> list[str]:
    output = git_output(["status", "--short"])
    return [line for line in output.splitlines() if line]


def stage_all() -> None:
    run_git(["add", "-A"])


def tokenise_path(path: str) -> list[str]:
    parts = re.split(r"[^a-zA-Z0-9]+", path.lower())
    return [part for part in parts if part and part not in NOISY_TOKENS and not part.isdigit()]


def infer_scope(files: list[str], diff: str) -> str:
    lowered = " ".join(files).lower() + "\n" + diff.lower()
    keyword_groups = [
        ("release version in CI", ["release", "version", "workflow"]),
        ("release version", ["release", "version"]),
        ("release workflow", ["release", "workflow"]),
        ("ci workflow", ["workflow", "github", "actions"]),
        ("menu bar app", ["menu", "tray"]),
        ("memory monitor", ["memory", "usage"]),
        ("settings panel", ["settings", "threshold"]),
        ("build pipeline", ["build", "bundle"]),
        ("tauri app", ["tauri"]),
    ]
    for label, needles in keyword_groups:
        if all(needle in lowered for needle in needles):
            return label

    tokens = Counter()
    for path in files:
        tokens.update(tokenise_path(path))
    for token, _ in tokens.most_common():
        if len(token) >= 3:
            return token.replace("-", " ")
    return "changes"


def infer_action(files: list[str], diff: str) -> str:
    lowered = diff.lower()
    added_files = any(line.startswith("?? ") for line in status_lines())
    if "verify" in lowered or "assert" in lowered or "expected" in lowered:
        return "verify"
    if "fix" in lowered or "error" in lowered or "bug" in lowered:
        return "fix"
    if "clean" in lowered or "rm -rf" in lowered or "remove" in lowered:
        return "clean"
    if added_files or any("/scripts/" in path or path.startswith("scripts/") for path in files):
        return "add"
    return "update"


def fallback_message(files: list[str], diff: str, max_length: int) -> str:
    action = infer_action(files, diff)
    scope = infer_scope(files, diff)

    message = f"{action} {scope}".strip()
    if len(message) <= max_length:
        return message

    shortened_scope = " ".join(scope.split()[:3]).strip()
    message = f"{action} {shortened_scope}".strip()
    if len(message) <= max_length:
        return message

    return message[:max_length].rstrip()


def compact_diff(diff: str, limit: int = 1200) -> str:
    lines: list[str] = []
    for line in diff.splitlines():
        if line.startswith(("+++", "---", "@@")):
            continue
        if line.startswith(("+", "-")):
            lines.append(line[:160])
        if len("\n".join(lines)) >= limit:
            break
    return "\n".join(lines[:40]).strip()


def build_prompt(mode: str, files: list[str], stat: str, diff: str, fallback: str, max_length: int) -> str:
    file_text = "\n".join(f"- {path}" for path in files) or "- none"
    diff_excerpt = compact_diff(diff) or "(no diff excerpt)"
    stat_text = stat or "(no diff stat)"
    return (
        f"You are using the {DEFAULT_MODEL} model to refine a git commit message.\n"
        "Return exactly one short imperative commit message line.\n"
        f"Constraints: under {max_length} characters, no quotes, no trailing period, no prefix explanation.\n"
        f"Diff mode: {mode}\n"
        f"Files:\n{file_text}\n\n"
        f"Diff stat:\n{stat_text}\n\n"
        f"Diff excerpt:\n{diff_excerpt}\n\n"
        f"Fallback message: {fallback}\n"
    )


def refine_with_command(prompt: str, fallback: str, max_length: int) -> tuple[str, str]:
    command = os.environ.get("ASKQUESTION_CMD", "").strip()
    if not command:
        return fallback, "heuristic"

    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            input=prompt,
            text=True,
            capture_output=True,
            shell=True,
            check=False,
        )
    except OSError:
        return fallback, "heuristic"

    candidate = result.stdout.strip().splitlines()
    message = candidate[0].strip() if candidate else ""
    if result.returncode != 0 or not message:
        return fallback, "heuristic"

    message = re.sub(r"^[\"'`]+|[\"'`]+$", "", message).strip()
    if not message:
        return fallback, "heuristic"
    return message[:max_length].rstrip(), "askquestion"


def create_commit(message: str) -> None:
    try:
        run_git(["commit", "-m", message])
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.stderr.strip() or exc.stdout.strip() or "git commit failed") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a short git commit message.")
    parser.add_argument(
        "--mode",
        choices=["auto", "staged", "unstaged", "all"],
        default="auto",
        help="Which diff to summarize. auto prefers staged changes.",
    )
    parser.add_argument(
        "--stage-all",
        action="store_true",
        help="Run git add -A before generating the message.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Create the git commit with the generated message.",
    )
    parser.add_argument(
        "--print-prompt",
        action="store_true",
        help="Print the askquestion refinement prompt before the final message.",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=int(os.environ.get("GIT_COMMIT_MAX_LEN", DEFAULT_MAX_LENGTH)),
        help="Maximum commit message length.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ensure_repo()

    if args.stage_all:
        stage_all()

    mode = resolve_mode(args.mode)
    files = name_only(mode)
    if not files:
        raise SystemExit("No changes found for the selected diff mode.")

    stat = diff_stat(mode)
    diff = diff_text(mode)
    fallback = fallback_message(files, diff, args.max_length)
    prompt = build_prompt(mode, files, stat, diff, fallback, args.max_length)
    message, source = refine_with_command(prompt, fallback, args.max_length)

    if args.print_prompt:
        print(prompt)
        print("---")

    print(message)
    print(f"[source: {source}]", file=sys.stderr)

    if args.commit:
        if args.stage_all:
            create_commit(message)
            return
        if mode != "staged":
            raise SystemExit("Use --mode staged or add --stage-all before committing.")
        if not has_staged_changes():
            raise SystemExit("No staged changes to commit.")
        create_commit(message)


if __name__ == "__main__":
    main()

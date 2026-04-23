---
name: git-commit
description: Generate a short git commit message from the current diff and optionally create the commit. Use when the user asks to summarize local code changes, draft a concise commit message, or automatically commit staged or unstaged changes. Prefer the askquestion model refinement path when available, and fall back to the bundled heuristic generator when it is not configured.
---

# Git Commit

## Quick Start

Preview a short commit message for the current changes:

```bash
python3 .agents/skills/git-commit/scripts/git_commit.py
```

Stage everything, generate a short message, and commit:

```bash
python3 .agents/skills/git-commit/scripts/git_commit.py --stage-all --commit
```

Preview a message from staged changes only:

```bash
python3 .agents/skills/git-commit/scripts/git_commit.py --mode staged
```

## Workflow

1. Check `git status --short` before committing.
2. If the diff contains unrelated work, split it into multiple commits instead of forcing one summary.
3. Run the bundled script to build a short message from changed files, diff stats, and key added or removed lines.
4. If `ASKQUESTION_CMD` is configured, let that command refine the message using the `askquestion` model contract described below.
5. If refinement is unavailable or fails, use the local heuristic message.
6. Only create the commit when the user explicitly asks to commit. Otherwise, return the preview text.

## askquestion Refinement

This skill treats `askquestion` as an optional refinement step instead of a hard dependency.

- `ASKQUESTION_MODEL` defaults to `askquestion` and is only used in the generated prompt text.
- `ASKQUESTION_CMD` is an optional shell command that reads a prompt from stdin and returns one short commit message on stdout.
- If `ASKQUESTION_CMD` is unset, exits non-zero, or returns an empty string, the script falls back to its local generator.

Recommended contract for `ASKQUESTION_CMD`:

- Input: the script sends a compact prompt with file list, diff stats, and a proposed fallback message over stdin.
- Output: exactly one short commit message line, without quotes or explanation.

## Guardrails

- Keep messages short and concrete. Prefer one line under 72 characters.
- Default to imperative wording such as `add`, `fix`, `update`, `clean`, or `verify`.
- Mention the most important behavior change, not every edited file.
- If both staged and unstaged changes exist, prefer staged changes unless the user explicitly wants a full auto-commit.
- Use `--stage-all --commit` only when it is acceptable to include every current change in one commit.

## Script

The skill ships with:

- `scripts/git_commit.py`

Key flags:

- `--mode auto|staged|unstaged|all`
- `--stage-all`
- `--commit`
- `--print-prompt`
- `--max-length <n>`

Use `--print-prompt` when wiring a new `ASKQUESTION_CMD` integration and you want to inspect the exact prompt being sent.

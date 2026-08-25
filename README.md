<!-- SPDX-License-Identifier: MPL-2.0 -->
# git-ai-review

[![npm](https://img.shields.io/npm/v/git-ai-review)](https://www.npmjs.com/package/git-ai-review)

Review your git diff with your locally installed **Codex CLI**, **Copilot CLI**, or **Claude CLI** — run it manually in one command or automatically as a git pre-commit hook.

## Quick start

Install and set up the git hook:

```bash
npm i -D git-ai-review
npx git-ai-review install
```

That's it. Every `git commit` will now run an AI review of your staged changes automatically.

You can also run reviews manually:

```bash
npx git-ai-review review
npx git-ai-review review --verbose
npx git-ai-review review --codex
npx git-ai-review review --copilot
npx git-ai-review review --claude
```

Or review the diff between two branches:

```bash
npx git-ai-review diff main
npx git-ai-review diff main feature-branch
```

Requirements for the target repo:
- An `AGENTS.md` file in the repo root is optional; when present it is used as policy context for the review
- At least one reviewer CLI must be installed and authenticated: **Codex CLI** (`codex login`), **Copilot CLI** (`copilot auth`), or **Claude CLI** (`claude`)

## License

This package is licensed under **MPL-2.0**.

## What it does

`git-ai-review` uses your locally installed AI CLIs to review staged changes before they are committed. You can run it on demand with a single command (`npx git-ai-review review`), review the diff between two branches (`npx git-ai-review diff main feature-branch`), or install it as a git hook so every commit is reviewed automatically.

- Uses your local **Codex CLI** as the primary reviewer.
- Falls back to **Copilot CLI**, then **Claude CLI** when the previous reviewer is unavailable.
- Blocks commit when:
  - any reviewer returns `status: fail`, or
  - any findings are returned (even with `status: pass`), or
  - all reviewers are unavailable.
- Tracks consecutive failures and enables a hard lock after a limit (default `10`).
- Builds prompt context from:
  - full `AGENTS.md`, when present,
  - tracked markdown files referenced by `AGENTS.md` (including wildcard refs like `deploy*.md`).
- Resolves binaries via environment variables or system PATH, with macOS app-bundle fallback for Codex (`/Applications/Codex.app/Contents/Resources/codex`).

## Prerequisites

At least one reviewer CLI must be installed and authenticated on each developer machine.
Recommended: install multiple for resilient fallback behavior.

- Codex CLI (`codex`) with active login (`codex login`) or `OPENAI_API_KEY` env var — primary reviewer
- Copilot CLI (`copilot`) with active login (`copilot auth`) or `GITHUB_TOKEN` env var
- Claude CLI (`claude`) with `ANTHROPIC_API_KEY` env var or OAuth login

When an API token env var is set, the network preflight check for that reviewer is skipped — this is useful in CI environments or when interactive OAuth login is not available.

Default fallback chain: Codex → Copilot → Claude. If a provider was unavailable on the previous run, it is rotated to the end of the chain on the next attempt (state stored in `.git/ai-review-last-unavailable`). The rotation persists until the unavailable provider is retried and found available again, preventing repeated preflight failures. If all are unavailable, review fails.

When a reviewer is explicitly selected via `--claude`, `--codex`, or `--copilot`, the preflight check is skipped entirely — the CLI tool handles its own authentication.

## Install in another repository

```bash
npm i -D git-ai-review
```

Install hook files and configure Git:

```bash
npx git-ai-review install
```

This creates/updates `.githooks/pre-commit` and sets:

```bash
git config core.hooksPath .githooks
```

## Commands

Via `npx`:

```bash
npx git-ai-review review
npx git-ai-review review --verbose
npx git-ai-review review --codex
npx git-ai-review review --copilot
npx git-ai-review review --claude
npx git-ai-review diff main
npx git-ai-review diff main feature-branch
npx git-ai-review diff main feature-branch --verbose
npx git-ai-review diff main feature-branch --codex
npx git-ai-review pre-commit
npx git-ai-review pre-commit --verbose
npx git-ai-review install
```

Via npm scripts (pass flags after `--`):

```bash
npm run git-ai-review -- review
npm run git-ai-review -- review --verbose
npm run git-ai-review -- review --codex
npm run git-ai-review -- review --copilot
npm run git-ai-review -- review --claude
npm run git-ai-review -- diff main
npm run git-ai-review -- diff main feature-branch
npm run git-ai-review -- diff main feature-branch --verbose
npm run git-ai-review -- pre-commit
npm run git-ai-review -- pre-commit --verbose
npm run git-ai-review -- install
```

`npm run ai-review` is an alias for `npm run git-ai-review` — both accept the same commands and flags.

- `review`: run AI review against staged diff.
- `review --verbose`: print full prompt plus raw model outputs to stdout.
- `review --codex`: force Codex reviewer only (skip Copilot/Claude fallback).
- `review --copilot`: force Copilot reviewer only (skip Codex/Claude).
- `review --claude`: force Claude reviewer only (skip Codex/Copilot).
- `diff <base> [head]`: run AI review for the diff between two branches/refs. Uses three-dot diff (`base...head`) to show changes introduced on `head` since it diverged from `base`. If `head` is omitted, defaults to `HEAD`. Supports the same `--verbose` and reviewer flags as `review`.
- `pre-commit`: run lock-aware pre-commit flow (recommended for hooks).
- `pre-commit --verbose`: same as pre-commit, but with detailed prompt/raw model logs.
- `install`: install hook script and set `core.hooksPath`.

The `--claude`, `--codex`, and `--copilot` flags are mutually exclusive and can be combined with `--verbose`.

## Repository requirements

In each target repository:

- `AGENTS.md` in repo root is optional; when present it is included as policy context.
- Optional referenced markdown docs (from `AGENTS.md`) should be tracked in git to be included in prompt context.
- Commits should be made with staged changes (`git add ...`) so diff is reviewable.

## Runtime behavior

- In CI (`CI=true|1|yes`) pre-commit review is skipped.
- Report is written to `.git/ai-review-last.json` by default.
- Last-unavailable provider state: `.git/ai-review-last-unavailable` (used for fallback rotation).
- Failure counter file: `.git/ai-review-fail-count`.
- Lock file after repeated failures: `.git/ai-review.lock`.
- Unlock manually by removing lock and fail-count files.

## Environment variables

- `ANTHROPIC_API_KEY`: Anthropic API token for Claude — skips network preflight when set.
- `OPENAI_API_KEY`: OpenAI API token for Codex — skips network preflight when set.
- `GITHUB_TOKEN`: GitHub token for Copilot — skips network preflight when set.
- `CODEX_BIN`: custom Codex executable path/name.
- `COPILOT_BIN`: custom Copilot executable path/name.
- `CLAUDE_BIN`: custom Claude executable path/name.
- `CLAUDE_MAX_TURNS`: max agentic turns for Claude CLI; default `2`.
- `COPILOT_REVIEW_MODEL`: default `gpt-5.3-codex`.
- `AI_REVIEW_TIMEOUT_MS`: default `300000` (5 min).
- `AI_REVIEW_PREFLIGHT_TIMEOUT_SEC`: default `8`.
- `AI_REVIEW_FAIL_LIMIT`: default `10`.
- `AI_REVIEW_REPORT_PATH`: custom report location.
- `AI_REVIEW_PROMPT_HEADER`: optional prompt-header override.
  - JSON array format example: `["Line 1","Line 2"]`
  - Multiline string format example: `Line 1\nLine 2`
  - If unset/empty, built-in default header lines are used.

## Verbose logging

Use `--verbose` to print:

- full generated review prompt
- raw Codex stdout/stderr and structured response file
- raw Copilot stdout/stderr
- raw Claude stdout/stderr

This is useful for debugging prompt behavior and model integration issues.

## Token usage

After each review, token usage is printed to stdout when available:

```
Tokens: input: 1234, output: 567
```

- **Input tokens**: tokens sent to the model (your prompt, diff, schema, AGENTS.md context).
- **Output tokens**: tokens generated by the model (the review JSON response).

For Claude, usage is reliably extracted from the CLI's JSON envelope. For Codex and Copilot, usage is extracted on a best-effort basis from CLI output and may not always be available.

## Example setup in a target repo

```bash
npm i -D git-ai-review
npx git-ai-review install
```

Then commit as usual:

```bash
git add .
git commit -m "Your change"
```

The hook will run automatically.

## Publishing

Typical release flow:

```bash
npm version patch
npm publish
```

Recommended checks before publish:

```bash
npm run typecheck
npm test
npm run build
npm publish --dry-run
```

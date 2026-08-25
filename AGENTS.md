# AGENTS.md — git-ai-review

This repository contains a publishable npm package for AI-powered Git review hooks.
All contributors and AI agents must follow these rules.

- If any rules from other .md files in this repository contradict AGENTS.md, immediately notify the user so the inconsistency can be corrected.

## Scope

- This package owns the `git-ai-review` CLI and related review/hook logic.
- Supports Codex CLI, Copilot CLI, and Claude CLI as reviewers (Codex is the primary reviewer).
- The package must remain reusable across arbitrary repositories.
- Avoid repo-specific assumptions except for explicit `AGENTS.md`-based policy loading.

## Project Structure

- Maintain a tree-based architecture: logically related modules, scripts, files, and resources must be grouped into dedicated directories and subdirectories.
- Do not mix logically unrelated scripts or modules in the same directory.
- When files share a common domain or feature, create a subdirectory for them.
- Merge directories that serve the same logical purpose; split directories that contain unrelated concerns.

## Architecture Rules

- Keep logic modular by domain:
  - CLI command parsing in `src/cli.ts`
  - review engine in `src/review.ts`
  - pre-commit lock flow in `src/precommit.ts`
  - hook installer in `src/install.ts`
  - prompt/context building in `src/prompt.ts`
  - git utilities in `src/git.ts`
  - review JSON schema in `src/schema.ts`
  - shared types in `src/types.ts`
- Do not collapse domains into a single large file.
- Export testable pure functions for parsing, policy extraction, and verdict logic.
- Never use inline code in npm scripts via `node -e` or `node --input-type=module -e`. Always keep code in dedicated script files.
- All imports must be at the top of the file, below the license header section. Inline imports (e.g., `await import()` inside functions) are prohibited.
- All changes must work on macOS, Linux, and Windows. Avoid platform-specific shell features (e.g., globstar, POSIX-only commands) in npm scripts; use cross-platform Node.js solutions or well-known npm packages instead.

## Prompt and Policy Rules

- `AGENTS.md` in target repository is optional policy input for review mode. When it is absent, review falls back to a prompt header that makes no reference to `AGENTS.md` rules.
- Prompt must include:
  - full `AGENTS.md`, when present
  - tracked markdown files referenced by `AGENTS.md` (including wildcard references)
  - staged diff (for `review` command) or branch-to-branch diff (for `diff` command)
- Do not include untracked/local arbitrary files in prompt context.
- Prompt header defaults must be stable and secure; allow override only through explicit config (`AI_REVIEW_PROMPT_HEADER`).
- Secrets must never be stored in repository files.

## Security Rules

- Never hardcode user-specific absolute paths or user-specific directories.
- Well-known OS-level application bundle fallback paths are allowed only when PATH/env discovery fails and behavior is test-covered.
- Binary resolution must use env override and/or system PATH discovery.
- Never log or hardcode secrets/tokens.
- Verbose mode may print prompts/raw model output; document that clearly and keep it opt-in.
- Keep lock and report files inside git path (`.git/...`) unless explicitly configured.

## Language and UX Rules

- All CLI and hook output must be in English.
- Error messages must be actionable and explicit.
- Blocking conditions must be deterministic and test-covered.

## Testing Rules

- Every logical block must be covered by tests.
- `// @ts-nocheck` is allowed only as a last resort after attempting to resolve the issue via refactoring.
- New behavior requires tests in `tests/**/*.test.mts`.
- Tests must verify real executable code paths (actual runtime or imported modules), not duplicated/copied logic inside test files.
- Required checks before merge/release:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`

## Packaging Rules

- Package must stay publishable to npm.
- Keep `bin` entry working for `npx git-ai-review ...`.
- Keep `README.md` aligned with real behavior and options.
- Keep semantic versioning discipline.

## Licensing Rules

- License is MPL-2.0.
- Keep SPDX header in all comment-capable source/test files.
- Do not add files that violate current license policy.

## Git Rules

- **`--no-verify` commits are strictly prohibited.** All commits must pass through the pre-commit hook with AI review. No exceptions.
- **No auto-generated files** in the repository (esbuild bundles, .zip archives, etc.), **except lockfiles** (`package-lock.json` for root and function packages). Add generated artifacts to `.gitignore`.
- **No binary files** in the repository, **except images** (.png, .jpg, .ico).

## Git and Release Rules

- Use feature branches and PRs; avoid direct pushes to protected mainline branches.
- Keep commits focused and atomic.
- For releases, run dry-run publish check before actual publish:
  - `npm publish --dry-run`

## Review Policy

When reviewing changes, prioritize:
1. security and data leakage risks,
2. behavioral regressions in hook blocking logic,
3. prompt correctness and policy coverage,
4. package usability in external repositories,
5. test and documentation completeness.

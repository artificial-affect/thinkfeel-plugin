# AGENTS.md

Assume nothing.
Be extremely terse.
Seek least-unintended-complexity-per-solution/LOC.

## Absolute Laws

- Fix root-causes, never patch/fallback.
- Never write new code when current code can do the job.
- Never abstract unless asked.
- Never create more files/functions than absolutely necessary.

## Pre-Commit Requirement

Before any commit, Codex must review the exact staged diff for:

- PII leaks
- secrets or credentials
- security regressions
- privacy regressions
- accidental local paths or personal data

Do not commit until that review is complete and any finding is fixed or explicitly accepted by the user.

## Commit Messages

Commit messages must start with `feat: `, `fix: `, or `chore: `.

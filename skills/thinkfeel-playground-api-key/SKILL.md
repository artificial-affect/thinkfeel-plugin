---
name: thinkfeel-playground-api-key
description: 'Use when Codex is asked to configure a ThinkFeel project or Playground API key. Treat this as the credential gate: inspect safely, ask reuse-vs-new before API work, and never expose plaintext.'
---

# ThinkFeel Playground API Key

Use this skill only in Codex local/app sessions. Keep plaintext out of normal tool output, and write secrets only to a confirmed local destination.

The plugin is a richer Codex-native wrapper around the general ThinkFeel CLI/SKILL flow. Prefer the native ThinkFeel env names unless the project explicitly uses the OpenAI-compatible completions endpoint.

## When To Use

Use this skill as the credential gate for ThinkFeel or Playground API-backed work.

Use it when:

- The user asks for a Playground or ThinkFeel API key.
- Codex will build, run, test, debug, or configure a ThinkFeel project that calls the Playground API.
- Codex needs to decide whether to reuse an existing key or create a new key before API work.
- The user explicitly needs `OPENAI_API_KEY` for an OpenAI-compatible `/api/v1/completions` client.

Do not use it when:

- The user only wants documentation, citations, model guidance, or examples.
- The user asks for a static UI with no API-backed behavior.
- The user names a different provider.

If API access is needed and no usable key is found, offer secure key provisioning instead of manual setup steps.

## Safety Rules

- Never request, print, summarize, quote, or paste a plaintext API key.
- Never inspect credentials with commands that can print secret values, such as `cat .env*`, `grep THINKFEEL_API_KEY .env*`, or `rg THINKFEEL_API_KEY .env*`.
- Inspect env files only with no-output checks that reveal presence/absence.
- Before creating a key or writing any secret, obtain explicit confirmation.
- Prefer ignored or untracked env files. In git repos, avoid tracked targets unless the user explicitly confirms that choice.
- The local helper may handle plaintext in memory and write it to the confirmed file. Its stdout/stderr must not include the key.
- When decrypting in a repo, pass the repo root as `--workspace`; the helper refuses symlink targets and targets outside that workspace.
- Keep user-facing messages concise.

## Mandatory First Step

Before editing, testing, running, debugging, or configuring any code that calls the Playground/OpenAI API:

1. Inspect for a usable `THINKFEEL_API_KEY` without printing it. If the project documents OpenAI-compatible completions, inspect for `OPENAI_API_KEY` instead.
2. Unless the user explicitly asked for a new key, ask whether to reuse an existing key or create a new one. If none exists, ask whether to create one.
3. Stop until the user answers.

Finding an existing key is not permission to proceed. It only changes the question you ask.

## Workflow

1. Inspect before acting:
   - look for a usable key without printing secret values in the current environment and likely local env files such as `.env.local`, `.env`, and ignored framework env files
   - check README/setup docs, `THINKFEEL_BASE_URL`, `OPENAI_BASE_URL`, and framework env docs for repo conventions separately from secret-bearing env files
   - default to `.env.local` and `THINKFEEL_API_KEY` when no stronger convention exists
   - use `OPENAI_API_KEY` only for OpenAI-compatible `/api/v1/completions` clients or explicit user request
2. Ask the credential decision question and stop until the user answers.
3. When creation is chosen, confirm the destination file/env var before writing:
   - use `tool_search` to load `confirm_thinkfeel_api_key_local_destination`
   - call it with the absolute workspace root, the recommended env-file target, and `THINKFEEL_API_KEY`
   - if it returns `approved`, use its returned `targetPath` exactly
   - if unavailable, ask exactly one short destination question and stop
4. Run the local helper `login` with the confirmed target path, workspace root, env var name, and `--persona-id` when the user supplied one. When supplied, the helper writes it as `THINKFEEL_PERSONA_ID`.
5. Verify by running the relevant project command when practical. Do not reveal or inspect the secret value directly.

## Helper

Use the helper by absolute path. `prepare` creates the temporary private key file plus a request JSON containing only the public JWK and requested key name:

```bash
node "<plugin root>/scripts/thinkfeel-playground-api-key.mjs" prepare --name "Codex"
```

After the connector returns `encrypted_api_key.ciphertext`, decrypt and write the key locally:

```bash
node "<plugin root>/scripts/thinkfeel-playground-api-key.mjs" decrypt \
  --private-key "<private key path from prepare>" \
  --ciphertext "<encrypted_api_key.ciphertext from connector result>" \
  --target "<confirmed env file path>" \
  --workspace "<repo root>" \
  --env-name THINKFEEL_API_KEY \
  --persona-id "<persona_id>"
```

The decrypt command updates or appends the env var, prints only safe write metadata, and refuses symlink or out-of-workspace targets.

For normal plugin setup, use `login` after destination confirmation:

```bash
node "<plugin root>/scripts/thinkfeel-playground-api-key.mjs" login \
  --target "<confirmed env file path>" \
  --workspace "<repo root>" \
  --env-name THINKFEEL_API_KEY \
  --persona-id "<persona_id>" \
  --name "Codex"
```

The login command opens the Playground browser sign-in flow, asks the user to approve key creation, receives only encrypted ciphertext from the browser, decrypts locally, and writes the env file without printing plaintext.

## References

- `references/evals.md`: trigger and routing eval cases for this skill.

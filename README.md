# ThinkFeel Plugin

Developer setup automation for ThinkFeel projects, packaged for both Codex and Claude Code.

## Install in Codex

Add the ThinkFeel marketplace source:

```bash
codex plugin marketplace add artificial-affect/thinkfeel-plugin
codex plugin add thinkfeel-plugin@thinkfeel
```

Alternatively, open the Codex plugin directory, choose the `ThinkFeel` marketplace, and install `ThinkFeel Plugin`. Start a new Codex thread after installation so Codex loads the plugin's skill and MCP server.

## Install in Claude Code

Add the ThinkFeel marketplace source:

```bash
/plugin marketplace add artificial-affect/thinkfeel-plugin
/plugin install thinkfeel-plugin@thinkfeel
```

For local development, load the checkout directly:

```bash
claude --plugin-dir ./thinkfeel-plugin
```

Run `/reload-plugins` after changing plugin manifests, MCP config, or other non-skill files.

## Requirements

- Node.js 20 or newer.
- Codex or Claude Code with plugin, skill, and MCP support.
- A Playground account with access to create API keys.

## API Key Setup Flow

The plugin confirms a local env-file destination first, then runs its own helper login flow. It does not call the npm `thinkfeel` CLI or `thinkfeel login`. The helper opens Playground browser sign-in, asks the user to approve key creation, receives only encrypted ciphertext from the browser callback, decrypts locally, and writes `THINKFEEL_API_KEY` without printing plaintext. If the user provides a persona ID, it also writes `THINKFEEL_PERSONA_ID`.

Use `OPENAI_API_KEY` only when configuring a project that explicitly uses the OpenAI-compatible `/api/v1/completions` endpoint or when the user asks for that env var.

## Direct Helper Usage

Agents normally invoke the skill and MCP confirmation flow for you. For local testing, run the helper directly after choosing an env-file destination inside the target workspace:

```bash
node scripts/thinkfeel-playground-api-key.mjs login \
  --target .env.local \
  --workspace <project-root> \
  --env-name THINKFEEL_API_KEY \
  --source codex \
  --name "ThinkFeel Plugin"
```

Use `--source codex` from Codex and `--source claude_code` from Claude Code.

## Security Model

- Plaintext API keys are never requested from the developer or printed to stdout.
- New key creation requires browser sign-in and explicit user approval in Playground.
- The browser callback posts only encrypted ciphertext to `127.0.0.1`.
- Env-file writes are confined to the confirmed workspace and refuse symlink, hard-link, and non-file targets.
- `OPENAI_API_KEY` is only for projects that explicitly use the OpenAI-compatible `/api/v1/completions` endpoint.

## Local Validation

```bash
node --test tests/thinkfeel-playground-api-key.test.mjs
```

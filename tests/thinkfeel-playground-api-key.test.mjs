import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const { subtle } = webcrypto;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/thinkfeel-playground-api-key.mjs');

const SKILL = path.resolve(__dirname, '../skills/thinkfeel-playground-api-key/SKILL.md');
const CURVE_LABS_LOGO = path.resolve(__dirname, '../assets/curve-labs-logo.png');
const CODEX_PLUGIN_MANIFEST = path.resolve(__dirname, '../.codex-plugin/plugin.json');
const CLAUDE_PLUGIN_MANIFEST = path.resolve(__dirname, '../.claude-plugin/plugin.json');
const CLAUDE_MARKETPLACE = path.resolve(__dirname, '../.claude-plugin/marketplace.json');
const CODEX_MCP_MANIFEST = path.resolve(__dirname, '../codex/mcp.json');
const CLAUDE_MCP_MANIFEST = path.resolve(__dirname, '../claude/mcp.json');

const MCP_SERVER = path.resolve(__dirname, '../mcp/server.mjs');
const TEST_API_KEY = ['tf', 'test', 'placeholder', 'value'].join('_');
const TEST_PERSONA_ID = 'persona-00000000-0000-0000-0000-000000000001';

function runScript(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runScriptRaw(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    timeout: 5_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runMcpServer(requests) {
  const input = requests.map(request => JSON.stringify(request)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    input,
    timeout: 5_000,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function encryptWithPublicJwk(publicJwk, plaintext) {
  const publicKey = await subtle.importKey('jwk', publicJwk, { hash: 'SHA-256', name: 'RSA-OAEP' }, false, ['encrypt']);
  const ciphertext = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, new TextEncoder().encode(plaintext));
  return base64url(ciphertext);
}

test('prepare writes private key locally and emits a public connector request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-helper-test-'));
  try {
    const output = JSON.parse(runScript(['prepare', '--name', 'Unit Test', '--dir', dir]));
    const request = JSON.parse(fs.readFileSync(output.request_path, 'utf8'));
    const privateKey = JSON.parse(fs.readFileSync(output.private_key_path, 'utf8'));

    assert.equal(request.name, 'Unit Test');
    assert.deepEqual(Object.keys(request.recipient_public_key_jwk).sort(), ['e', 'kty', 'n']);
    assert.equal(request.recipient_public_key_jwk.kty, 'RSA');
    assert.equal(request.recipient_public_key_jwk.e, 'AQAB');
    assert.equal(Boolean(privateKey.d), true);
    assert.equal(output.recipient_public_key_jwk.d, undefined);
  } finally {
    removeTempDir(dir);
  }
});

test('decrypt writes only safe metadata to stdout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-helper-test-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-workspace-'));
  try {
    const output = JSON.parse(runScript(['prepare', '--name', 'Unit Test', '--dir', dir]));
    const ciphertext = await encryptWithPublicJwk(output.recipient_public_key_jwk, TEST_API_KEY);
    const result = JSON.parse(
      runScript([
        'decrypt',
        '--private-key',
        output.private_key_path,
        '--ciphertext',
        ciphertext,
        '--target',
        '.env.local',
        '--workspace',
        workspace,
        '--persona-id',
        TEST_PERSONA_ID,
      ])
    );

    const envPath = path.join(workspace, '.env.local');
    assert.equal(result.target_path, fs.realpathSync(envPath));

    assert.equal(result.env_name, 'THINKFEEL_API_KEY');
    assert.equal(result.persona_env_name, 'THINKFEEL_PERSONA_ID');

    assert.equal(result.wrote_plaintext_to_stdout, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_API_KEY));
    assert.equal(fs.readFileSync(envPath, 'utf8').includes(`THINKFEEL_API_KEY=${TEST_API_KEY}`), true);
    assert.equal(fs.readFileSync(envPath, 'utf8').includes(`THINKFEEL_PERSONA_ID=${TEST_PERSONA_ID}`), true);
  } finally {
    removeTempDir(dir);
    removeTempDir(workspace);
  }
});

test('plugin registers the local destination confirmation MCP tool', () => {
  const pluginManifest = JSON.parse(fs.readFileSync(CODEX_PLUGIN_MANIFEST, 'utf8'));
  const codexMcpManifest = JSON.parse(fs.readFileSync(CODEX_MCP_MANIFEST, 'utf8'));
  const claudeMcpManifest = JSON.parse(fs.readFileSync(CLAUDE_MCP_MANIFEST, 'utf8'));
  const responses = runMcpServer([
    {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'thinkfeel-plugin-test', version: '0.2.0' },
      },
    },
    {
      id: 2,
      params: {},
      jsonrpc: '2.0',
      method: 'tools/list',
    },
  ]);

  assert.equal(pluginManifest.name, 'thinkfeel-plugin');
  assert.equal(pluginManifest.mcpServers, './codex/mcp.json');
  assert.deepEqual(codexMcpManifest.mcpServers['thinkfeel-api-key-local-confirmation'].args, ['./mcp/server.mjs']);
  assert.deepEqual(claudeMcpManifest.mcpServers['thinkfeel-api-key-local-confirmation'].args, [
    '${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs',
  ]);
  assert.equal(responses[0].result.serverInfo.name, 'ThinkFeel Plugin MCP');
  assert.deepEqual(
    responses[1].result.tools.map(tool => tool.name),
    ['confirm_thinkfeel_api_key_local_destination']
  );
});

test('local destination confirmation accepts an override inside the workspace', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-mcp-test-'));
  try {
    const responses = runMcpServer([
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'thinkfeel-plugin-test', version: '0.2.0' },
        },
      },
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'confirm_thinkfeel_api_key_local_destination',
          arguments: { workspacePath: workspace, targetPath: '.env.local' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 'server-1',
        result: { action: 'accept', content: { targetPath: '.env.test' } },
      },
    ]);

    const result = responses.find(response => response.id === 2);
    assert.equal(result.result.structuredContent.status, 'approved');
    assert.equal(result.result.structuredContent.envName, 'THINKFEEL_API_KEY');
    assert.equal(result.result.structuredContent.targetPath, path.join(workspace, '.env.test'));
  } finally {
    removeTempDir(workspace);
  }
});

test('login rejects unknown agent source values before starting setup', () => {
  const result = runScriptRaw(['login', '--target', '.env.local', '--source', 'unknown_agent']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --source\. Use codex or claude_code\./);
});

test('skill documents credential gates and helper login flow', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const helper = fs.readFileSync(SCRIPT, 'utf8');
  const claudePluginManifest = JSON.parse(fs.readFileSync(CLAUDE_PLUGIN_MANIFEST, 'utf8'));
  const claudeMarketplace = JSON.parse(fs.readFileSync(CLAUDE_MARKETPLACE, 'utf8'));

  assert.equal(claudePluginManifest.name, 'thinkfeel-plugin');
  assert.equal(claudePluginManifest.mcpServers, './claude/mcp.json');
  assert.equal(claudeMarketplace.plugins[0].name, 'thinkfeel-plugin');
  assert.match(skill, /Treat this as the credential gate/);
  assert.match(skill, /Never inspect credentials with commands that can print secret values/);
  assert.match(skill, /confirm_thinkfeel_api_key_local_destination/);
  assert.match(skill, /thinkfeel-playground-api-key\.mjs" login/);
  assert.match(skill, /receives only encrypted ciphertext/);
  assert.match(skill, /THINKFEEL_API_KEY/);
  assert.match(skill, /THINKFEEL_PERSONA_ID/);
  assert.match(skill, /OPENAI_API_KEY/);
  assert.match(helper, /LOGIN_SOURCE_VALUES = new Set\(\['codex', 'claude_code'\]\)/);
  assert.match(helper, /LOGIN_SOURCE_DISPLAY_NAMES = \{ claude_code: 'Claude Code', codex: 'Codex' \}/);
  assert.match(helper, /loginUrl\.searchParams\.set\('source', source\)/);
  assert.match(helper, /form\.get\('error'\)/);
  assert.match(helper, /function localSuccessPage/);
  assert.match(helper, /function localLogoDataUrl/);
  assert.match(helper, /border-width: 1px 0/);
  assert.match(helper, /border-width: 1px/);
  assert.match(helper, /ThinkFeel key setup is complete\.<br \/>You can close this tab\./);
  assert.match(helper, /Status 200/);
  assert.match(helper, /value="Successfully completed\."/);
  assert.match(helper, /onclick="window\.close\(\)">Done/);
  assert.equal(fs.existsSync(CURVE_LABS_LOGO), true);
});

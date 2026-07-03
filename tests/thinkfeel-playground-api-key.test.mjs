import { execFileSync, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { subtle } = webcrypto;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../scripts/thinkfeel-playground-api-key.mjs");
const SKILL = path.resolve(__dirname, "../skills/thinkfeel-playground-api-key/SKILL.md");
const PLUGIN_MANIFEST = path.resolve(__dirname, "../.codex-plugin/plugin.json");
const MCP_MANIFEST = path.resolve(__dirname, "../.mcp.json");
const MCP_SERVER = path.resolve(__dirname, "../mcp/server.mjs");
const TEST_API_KEY = ["tf", "test", "placeholder", "value"].join("_");
const TEST_PERSONA_ID = "persona-00000000-0000-0000-0000-000000000001";

function runScript(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runMcpServer(requests) {
  const input = requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function encryptWithPublicJwk(publicJwk, plaintext) {
  const publicKey = await subtle.importKey(
    "jwk",
    publicJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
  const ciphertext = await subtle.encrypt(
    {
      name: "RSA-OAEP",
    },
    publicKey,
    new TextEncoder().encode(plaintext),
  );
  return base64url(ciphertext);
}

test("prepare writes private key locally and emits a public connector request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkfeel-playground-helper-test-"));
  try {
    const output = JSON.parse(runScript(["prepare", "--name", "Unit Test", "--dir", dir]));
    const request = JSON.parse(fs.readFileSync(output.request_path, "utf8"));
    const privateKey = JSON.parse(fs.readFileSync(output.private_key_path, "utf8"));

    assert.equal(request.name, "Unit Test");
    assert.deepEqual(Object.keys(request.recipient_public_key_jwk).sort(), ["e", "kty", "n"]);
    assert.equal(request.recipient_public_key_jwk.kty, "RSA");
    assert.equal(request.recipient_public_key_jwk.e, "AQAB");
    assert.equal(Boolean(privateKey.d), true);
    assert.equal(output.recipient_public_key_jwk.d, undefined);
  } finally {
    removeTempDir(dir);
  }
});

test("decrypt writes only safe metadata to stdout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkfeel-playground-helper-test-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "thinkfeel-playground-workspace-"));
  try {
    const output = JSON.parse(runScript(["prepare", "--name", "Unit Test", "--dir", dir]));
    const ciphertext = await encryptWithPublicJwk(output.recipient_public_key_jwk, TEST_API_KEY);
    const result = JSON.parse(runScript([
      "decrypt",
      "--private-key",
      output.private_key_path,
      "--ciphertext",
      ciphertext,
      "--target",
      ".env.local",
      "--workspace",
      workspace,
      "--persona-id",
      TEST_PERSONA_ID,
    ]));

    const envPath = path.join(workspace, ".env.local");
    assert.equal(result.target_path, fs.realpathSync(envPath));
    assert.equal(result.env_name, "THINKFEEL_API_KEY");
    assert.equal(result.persona_env_name, "THINKFEEL_PERSONA_ID");
    assert.equal(result.wrote_plaintext_to_stdout, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_API_KEY));
    assert.equal(fs.readFileSync(envPath, "utf8").includes(`THINKFEEL_API_KEY=${TEST_API_KEY}`), true);
    assert.equal(fs.readFileSync(envPath, "utf8").includes(`THINKFEEL_PERSONA_ID=${TEST_PERSONA_ID}`), true);
  } finally {
    removeTempDir(dir);
    removeTempDir(workspace);
  }
});

test("plugin registers the local destination confirmation MCP tool", () => {
  const pluginManifest = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MCP_MANIFEST, "utf8"));
  const responses = runMcpServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "thinkfeel-codex-dev-test", version: "0.1.1" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  ]);

  assert.equal(pluginManifest.mcpServers, "./.mcp.json");
  assert.deepEqual(
    manifest.mcpServers["thinkfeel-api-key-local-confirmation"].args,
    ["./mcp/server.mjs"],
  );
  assert.equal(responses[0].result.serverInfo.name, "ThinkFeel Codex Dev MCP");
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    ["confirm_thinkfeel_api_key_local_destination"],
  );
});

test("local destination confirmation accepts an override inside the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "thinkfeel-playground-mcp-test-"));
  try {
    const responses = runMcpServer([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "thinkfeel-codex-dev-test", version: "0.1.1" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "confirm_thinkfeel_api_key_local_destination",
          arguments: {
            workspacePath: workspace,
            targetPath: ".env.local",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: "server-1",
        result: {
          action: "accept",
          content: {
            targetPath: ".env.test",
          },
        },
      },
    ]);

    const result = responses.find((response) => response.id === 2);
    assert.equal(result.result.structuredContent.status, "approved");
    assert.equal(result.result.structuredContent.envName, "THINKFEEL_API_KEY");
    assert.equal(result.result.structuredContent.targetPath, path.join(workspace, ".env.test"));
  } finally {
    removeTempDir(workspace);
  }
});

test("skill documents credential gates and helper login flow", () => {
  const skill = fs.readFileSync(SKILL, "utf8");
  const helper = fs.readFileSync(SCRIPT, "utf8");

  assert.match(skill, /Treat this as the credential gate/);
  assert.match(skill, /Never inspect credentials with commands that can print secret values/);
  assert.match(skill, /confirm_thinkfeel_api_key_local_destination/);
  assert.match(skill, /thinkfeel-playground-api-key\.mjs" login/);
  assert.match(skill, /receives only encrypted ciphertext/);
  assert.match(skill, /THINKFEEL_API_KEY/);
  assert.match(skill, /THINKFEEL_PERSONA_ID/);
  assert.match(skill, /OPENAI_API_KEY/);
  assert.match(helper, /loginUrl\.searchParams\.set\('source', 'codex'\)/);
  assert.match(helper, /form\.get\('error'\)/);
});

#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { webcrypto, randomUUID } from 'node:crypto';

const { subtle } = webcrypto;

const ENCRYPTED_API_KEY_VERSION = 1;
const DEFAULT_ENV_NAME = 'THINKFEEL_API_KEY';
const PERSONA_ENV_NAME = 'THINKFEEL_PERSONA_ID';
const DEFAULT_BASE_URL = 'https://playground.curvelabs.org';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_API_KEY_PATTERN = /^(sk-[A-Za-z0-9_-]+|tf[_-][A-Za-z0-9_-]+)$/;

const OPTIONS_WITH_VALUES = new Set([
  'ciphertext',
  'dir',
  'base-url',
  'encrypted-result',
  'env-name',
  'name',
  'persona-id',
  'private-key',
  'target',
  'workspace',
]);

const VALID_OPTIONS = new Set(OPTIONS_WITH_VALUES);
const OPTIONS_ALLOWING_DASH_VALUES = new Set(['ciphertext']);

function usage() {
  return `Usage:
  thinkfeel-playground-api-key.mjs prepare [--name <key name>] [--dir <state dir>]
  thinkfeel-playground-api-key.mjs login --target <path> [--workspace <repo root>] [--env-name THINKFEEL_API_KEY] [--persona-id <id>] [--name Codex] [--base-url <url>]
  thinkfeel-playground-api-key.mjs decrypt --private-key <path> --target <path> (--ciphertext <value> | --encrypted-result <path>) [--env-name THINKFEEL_API_KEY] [--persona-id <id>] [--workspace <repo root>]

Commands:
  prepare   Generate a local RSA-OAEP keypair and public connector request.
  login     Create a key through browser sign-in, decrypt locally, and write it to an env file.
  decrypt   Decrypt connector ciphertext locally and upsert an env var file.

The helper never prints the plaintext API key.`;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!VALID_OPTIONS.has(key)) {
      fail(`Unknown option: --${key}.`);
    }
    const value = argv[index + 1];
    if (OPTIONS_WITH_VALUES.has(key)) {
      if (value == null) fail(`Missing value for --${key}.`);
      if (value.startsWith('--') && !OPTIONS_ALLOWING_DASH_VALUES.has(key)) fail(`Missing value for --${key}.`);

      args[key] = value;
      index += 1;
      continue;
    }
  }
  return args;
}

const printJson = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const base64urlJson = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function ensureUsableNodeCrypto() {
  if (subtle == null) fail('This helper requires Node.js WebCrypto support.');
}

function resolveOutputDir(rawDir) {
  if (rawDir) {
    const dir = path.resolve(String(rawDir));

    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    chmodBestEffort(dir, 0o700);
    return dir;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-'));
}

function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort only; chmod is not available on every filesystem.
  }
}

function unlinkBestEffort(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // Best effort cleanup for temporary files.
  }
}

const NOFOLLOW_OPEN_FLAG = fs.constants.O_NOFOLLOW ?? 0;

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realpathSyncOrFail(filePath, label) {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    fail(`Failed to resolve ${label}: ${error.message}`);
  }
}

function statDirectoryOrFail(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(`Failed to access ${label}: ${error.message}`);
  }
  if (!stat.isDirectory()) {
    fail(`${label} is not a directory: ${filePath}`);
  }
}

function resolveWorkspaceRoot(rawWorkspace) {
  const workspacePath = path.resolve(rawWorkspace || process.cwd());
  statDirectoryOrFail(workspacePath, 'Workspace');

  return { requested_path: workspacePath, real_path: realpathSyncOrFail(workspacePath, 'workspace') };
}

function resolveSafeTarget(targetPath, workspace) {
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspace.requested_path, targetPath);

  const parentPath = path.dirname(resolvedTarget);
  statDirectoryOrFail(parentPath, 'Target parent directory');
  const parentRealPath = realpathSyncOrFail(parentPath, 'target parent directory');

  if (!isPathInside(workspace.real_path, parentRealPath)) {
    fail(`Target env file must be inside the workspace. Workspace: ${workspace.real_path}. Target: ${resolvedTarget}`);
  }

  return path.join(parentRealPath, path.basename(resolvedTarget));
}

function lstatTarget(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Failed to inspect target env file: ${error.message}`);
  }
}

function validateTargetFileType(filePath, stat) {
  if (stat == null) return;
  if (stat.isSymbolicLink()) fail(`Refusing to write API key through symlink target: ${filePath}`);

  if (!stat.isFile()) fail(`Refusing to write API key to non-file target: ${filePath}`);
  if (stat.nlink > 1) fail(`Refusing to write API key to hard-linked target: ${filePath}`);
}

function openNoFollow(filePath, flags, mode, action) {
  try {
    return fs.openSync(filePath, flags | NOFOLLOW_OPEN_FLAG, mode);
  } catch (error) {
    if (error.code === 'ELOOP') fail(`Refusing to ${action} symlink target: ${filePath}`);
    if (error.code === 'EEXIST') fail(`Target env file changed while writing; refusing to overwrite: ${filePath}`);

    fail(`Failed to ${action} target env file safely: ${error.message}`);
  }
}

function readFileNoFollow(filePath) {
  const fd = openNoFollow(filePath, fs.constants.O_RDONLY, undefined, 'read');

  let contents = '';
  let failure = null;

  try {
    const stat = fs.fstatSync(fd);

    if (!stat.isFile()) failure = `Refusing to read non-file target env file: ${filePath}`;
    else contents = fs.readFileSync(fd, 'utf8');
  } catch (error) {
    failure = `Failed to read target env file safely: ${error.message}`;
  } finally {
    fs.closeSync(fd);
  }

  if (failure) fail(failure);
  return contents;
}

function writeFileNoFollow(filePath, contents) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = openNoFollow(tempPath, flags, 0o600, 'create temporary');
  let failure = null;

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) failure = `Refusing to write API key to non-file temporary target: ${tempPath}`;
    else fs.writeFileSync(fd, contents, { encoding: 'utf8' });
  } catch (error) {
    failure = `Failed to write target env file safely: ${error.message}`;
  } finally {
    fs.closeSync(fd);
  }

  if (failure) {
    unlinkBestEffort(tempPath);
    fail(failure);
  }

  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    unlinkBestEffort(tempPath);
    fail(`Failed to replace target env file safely: ${error.message}`);
  }
  chmodBestEffort(filePath, 0o600);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
  chmodBestEffort(filePath, 0o600);
}

function minimalPublicJwk(publicJwk) {
  if (publicJwk.kty !== 'RSA' || !publicJwk.n || !publicJwk.e) fail('Generated keypair did not produce an RSA public JWK.');
  return { kty: 'RSA', n: publicJwk.n, e: publicJwk.e };
}

async function generateRecipientKeyPair() {
  ensureUsableNodeCrypto();

  const keyPair = await subtle.generateKey(
    { hash: 'SHA-256', name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([0x01, 0x00, 0x01]) },
    true,
    ['encrypt', 'decrypt']
  );

  const publicJwk = minimalPublicJwk(await subtle.exportKey('jwk', keyPair.publicKey));
  return { privateKey: keyPair.privateKey, publicJwk };
}

async function prepare(args) {
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Codex';
  const outputDir = resolveOutputDir(args.dir);

  const privateKeyPath = path.join(outputDir, 'recipient-private-key.jwk.json');
  const requestPath = path.join(outputDir, 'connector-request.json');

  const keyPair = await generateRecipientKeyPair();
  const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
  const request = { name, recipient_public_key_jwk: keyPair.publicJwk };

  writeJson(privateKeyPath, privateJwk);
  writeJson(requestPath, request);

  printJson({
    name,
    request_path: requestPath,
    private_key_path: privateKeyPath,
    recipient_public_key_jwk: keyPair.publicJwk,
  });
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Failed to read ${label}: ${error.message}`);
  }
}

function encryptedPayloadFromArgs(args) {
  if (typeof args.ciphertext === 'string') return { ciphertext: args.ciphertext, version: ENCRYPTED_API_KEY_VERSION };

  if (typeof args['encrypted-result'] === 'string') {
    const raw = readJson(path.resolve(args['encrypted-result']), 'encrypted result JSON');
    const payload =
      raw?.encrypted_api_key ?? raw?.structuredContent?.encrypted_api_key ?? raw?.structured_content?.encrypted_api_key;

    if (payload && typeof payload === 'object') return payload;
  }

  fail('Provide --ciphertext or --encrypted-result.');
}

function base64urlToBytes(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    fail('Encrypted ciphertext must be base64url.');
  }
  return Buffer.from(value, 'base64url');
}

async function importPrivateKey(privateKeyPath) {
  ensureUsableNodeCrypto();
  const privateJwk = readJson(privateKeyPath, 'private key JWK');
  return subtle.importKey('jwk', privateJwk, { hash: 'SHA-256', name: 'RSA-OAEP' }, false, ['decrypt']);
}

async function decryptPayload(privateKeyPath, encryptedPayload) {
  const privateKey = await importPrivateKey(privateKeyPath);
  return decryptPayloadWithPrivateKey(privateKey, encryptedPayload);
}

async function decryptPayloadWithPrivateKey(privateKey, encryptedPayload) {
  ensureUsableNodeCrypto();

  if (encryptedPayload.version !== ENCRYPTED_API_KEY_VERSION) {
    fail(`Unsupported encrypted API key version: ${encryptedPayload.version}`);
  }
  if (typeof encryptedPayload.ciphertext !== 'string') fail('Encrypted API key ciphertext is missing.');

  try {
    const plaintext = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, base64urlToBytes(encryptedPayload.ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch {
    fail('Failed to decrypt encrypted API key.');
  }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  execFile(command, args, error => {
    if (error) {
      process.stderr.write(`Open this URL in your browser:\n${url}\n`);
    }
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');

    request.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('Login callback payload is too large.'));
        request.destroy();
      }
    });

    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function startLoginCallbackServer(state) {
  let resolveCallback = () => {};
  let rejectCallback = () => {};

  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const serverReady = new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/thinkfeel/callback') {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('Not found');
          return;
        }

        const form = new URLSearchParams(await readRequestBody(request));
        if (form.get('state') !== state) throw new Error('Invalid login callback state.');

        const loginError = form.get('error');
        if (loginError) throw new Error(loginError);

        const encryptedApiKeyRaw = form.get('encrypted_api_key');
        if (!encryptedApiKeyRaw) throw new Error('Missing encrypted API key.');

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><title>ThinkFeel Login</title><p>ThinkFeel key setup complete. You can close this tab.</p>'
        );
        server.close();
        resolveCallback(JSON.parse(encryptedApiKeyRaw));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
        server.close();
        rejectCallback(error);
      }
    });

    const timeout = setTimeout(
      () => {
        server.close();
        rejectCallback(new Error('Timed out waiting for browser login.'));
      },
      5 * 60 * 1000
    );

    server.on('close', () => clearTimeout(timeout));
    server.on('error', error => {
      reject(error);
      rejectCallback(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        const error = new Error('Failed to start local login callback.');

        reject(error);
        rejectCallback(error);

        return;
      }

      resolve({ callbackPromise, redirectUri: `http://127.0.0.1:${address.port}/thinkfeel/callback` });
    });
  });

  return serverReady;
}

function validateEnvName(envName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) fail(`Invalid env var name: ${envName}`);
}

function validateApiKey(value) {
  if (!SAFE_API_KEY_PATTERN.test(value)) fail('Decrypted API key is not a safe ThinkFeel/OpenAI API key literal.');
}

function validatePersonaId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\r\n\0]/.test(value)) {
    fail('Persona ID is not a safe env literal.');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) fail('Persona ID contains unsupported characters.');
}

function upsertEnvValue(targetPath, envName, value, workspacePath, valueKind = 'api-key') {
  validateEnvName(envName);

  if (valueKind === 'persona-id') validatePersonaId(value);
  else validateApiKey(value);

  const workspace = resolveWorkspaceRoot(workspacePath);
  const resolvedTarget = resolveSafeTarget(targetPath, workspace);

  const targetStat = lstatTarget(resolvedTarget);
  validateTargetFileType(resolvedTarget, targetStat);

  const existed = targetStat != null;
  const original = existed ? readFileNoFollow(resolvedTarget) : '';

  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];

  let updatedExisting = false;
  const envPattern = new RegExp(`^(export\\s+)?${envName}=`);

  const updatedLines = lines.map(line => {
    const match = line.match(envPattern);
    if (match) {
      updatedExisting = true;
      return `${match[1] ?? ''}${envName}=${value}`;
    }
    return line;
  });

  let nextContent;
  if (updatedExisting) nextContent = updatedLines.join(newline);
  else if (original.length === 0) nextContent = `${envName}=${value}${newline}`;
  else if (original.endsWith('\n')) nextContent = `${original}${envName}=${value}${newline}`;
  else nextContent = `${original}${newline}${envName}=${value}${newline}`;

  writeFileNoFollow(resolvedTarget, nextContent);

  return { existed, env_name: envName, target_path: resolvedTarget, updated_existing: updatedExisting };
}

function getPersonaId(args) {
  if (typeof args['persona-id'] !== 'string') return null;
  const personaId = args['persona-id'].trim();
  if (!personaId) return null;

  validatePersonaId(personaId);
  return personaId;
}

async function decrypt(args) {
  if (typeof args['private-key'] !== 'string') fail('Missing --private-key.');
  if (typeof args.target !== 'string') fail('Missing --target.');

  const envName =
    typeof args['env-name'] === 'string' && args['env-name'].trim() ? args['env-name'].trim() : DEFAULT_ENV_NAME;
  const workspacePath = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();

  const personaId = getPersonaId(args);
  const encryptedPayload = encryptedPayloadFromArgs(args);
  const plaintextApiKey = await decryptPayload(path.resolve(args['private-key']), encryptedPayload);

  const writeResult = upsertEnvValue(args.target, envName, plaintextApiKey, workspacePath);
  const personaWriteResult = personaId
    ? upsertEnvValue(args.target, PERSONA_ENV_NAME, personaId, workspacePath, 'persona-id')
    : null;

  printJson({
    ...writeResult,
    persona_env_name: personaWriteResult?.env_name,
    persona_target_path: personaWriteResult?.target_path,
    wrote_plaintext_to_stdout: false,
  });
}

async function login(args) {
  if (typeof args.target !== 'string') fail('Missing --target.');
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Codex';

  const envName =
    typeof args['env-name'] === 'string' && args['env-name'].trim() ? args['env-name'].trim() : DEFAULT_ENV_NAME;

  const workspacePath = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
  const personaId = getPersonaId(args);

  const baseUrl =
    typeof args['base-url'] === 'string' && args['base-url'].trim() ? args['base-url'].trim() : DEFAULT_BASE_URL;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const state = randomUUID();

  const keyPair = await generateRecipientKeyPair();
  const { callbackPromise, redirectUri } = await startLoginCallbackServer(state);

  const loginUrl = new URL('/api/thinkfeel/cli/login', normalizedBaseUrl);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('name', name);

  loginUrl.searchParams.set('source', 'codex');
  loginUrl.searchParams.set('redirect_uri', redirectUri);
  loginUrl.searchParams.set('recipient_public_key_jwk', base64urlJson(keyPair.publicJwk));

  openBrowser(loginUrl.toString());

  const encryptedPayload = await callbackPromise;
  const plaintextApiKey = await decryptPayloadWithPrivateKey(keyPair.privateKey, encryptedPayload);

  const writeResult = upsertEnvValue(args.target, envName, plaintextApiKey, workspacePath);

  const personaWriteResult = personaId
    ? upsertEnvValue(args.target, PERSONA_ENV_NAME, personaId, workspacePath, 'persona-id')
    : null;

  printJson({
    ...writeResult,
    persona_env_name: personaWriteResult?.env_name,
    persona_target_path: personaWriteResult?.target_path,
    source: 'codex',
    wrote_plaintext_to_stdout: false,
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command == null || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const args = parseArgs(rest);
  if (command === 'prepare') {
    await prepare(args);
    return;
  }
  if (command === 'login') {
    await login(args);
    return;
  }
  if (command === 'decrypt') {
    await decrypt(args);
    return;
  }

  fail(`Unknown command: ${command}\n${usage()}`);
}

main().catch(error => {
  process.stderr.write(`thinkfeel-playground-api-key failed: ${error.message}\n`);
  process.exit(1);
});

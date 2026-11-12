#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { webcrypto, randomUUID } from 'node:crypto';
const { subtle } = webcrypto;
const ENCRYPTED_API_KEY_VERSION = 1;
const LOGIN_SOURCE_VALUES = new Set(['codex', 'claude_code']);
const LOGIN_SOURCE_DISPLAY_NAMES = { codex: 'Codex', claude_code: 'Claude Code' };

const OPTIONS = new Set([
  'ciphertext',
  'dir',
  'base-url',
  'encrypted-result',
  'env-name',
  'name',
  'persona-id',
  'private-key',
  'source',
  'target',
  'workspace',
]);

const USAGE = `Usage:
  thinkfeel-playground-api-key.mjs prepare [--name <key name>] [--dir <state dir>]
  thinkfeel-playground-api-key.mjs login --target <path> [--workspace <repo root>] [--env-name THINKFEEL_API_KEY] [--persona-id <id>] [--name Codex] [--source codex|claude_code] [--base-url <url>]
  thinkfeel-playground-api-key.mjs decrypt --private-key <path> --target <path> (--ciphertext <value> | --encrypted-result <path>) [--env-name THINKFEEL_API_KEY] [--persona-id <id>] [--workspace <repo root>]

Commands:
  prepare   Generate a local RSA-OAEP keypair and public connector request.
  login     Create a key through browser sign-in, decrypt locally, and write it to an env file.
  decrypt   Decrypt connector ciphertext locally and upsert an env var file.

The helper never prints the plaintext API key.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    if (!OPTIONS.has(key)) fail(`Unknown option: --${key}.`);
    const value = argv[++index];
    if (value == null || (value.startsWith('--') && key !== 'ciphertext')) fail(`Missing value for --${key}.`);
    args[key] = value;
  }

  return args;
}

const printJson = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const loginHtmlStyles = `
      :root {
        --background: 0 0% 100%;
        --foreground: 240 10% 3.9%;
        --card: 0 0% 100%;
        --card-foreground: 240 10% 3.9%;
        --primary: 240 5.9% 10%;
        --primary-foreground: 0 0% 98%;
        --muted: 240 4.8% 95.9%;
        --muted-foreground: 240 3.8% 46.1%;
        --accent: 240 4.8% 95.9%;
        --accent-foreground: 240 5.9% 10%;
        --border: 240 5.9% 90%;
        --input: 240 5.9% 90%;
        --ring: 240 10% 3.9%;
        color-scheme: light;
      }
      * { box-sizing: border-box; border-color: hsl(var(--border)); }
      body {
        min-height: 100dvh;
        margin: 0;
        background: #fff;
        color: hsl(var(--foreground));
        font-family: Arial, Helvetica, sans-serif;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        line-height: 1.5;
      }
      .auth-logo {
        position: fixed;
        left: 50%;
        top: 2rem;
        z-index: 51;
        width: auto;
        height: 1.25rem;
        object-fit: contain;
        margin: 0;
        transform: translateX(-50%);
      }
      .auth-warning {
        position: fixed;
        left: 50%;
        bottom: 2rem;
        z-index: 51;
        width: min(calc(100% - 2rem), 36rem);
        margin: 0;
        transform: translateX(-50%);
        color: hsl(var(--muted-foreground));
        font-size: 0.75rem;
        line-height: 1rem;
        text-align: center;
      }
      .auth-panel {
        position: fixed;
        left: 50%;
        top: 50%;
        z-index: 50;
        display: grid;
        width: 100%;
        transform: translate(-50%, -50%);
        gap: 1rem;
        border-color: hsl(var(--border));
        border-style: solid;
        border-width: 1px 0;
        background: hsl(var(--background));
        padding: calc(1.5rem - 1px);
        transition-duration: 200ms;
      }
      .auth-close {
        position: absolute;
        right: calc(1rem - 1px);
        top: calc(1rem - 1px);
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        opacity: 0.7;
        outline: none;
        padding: 0;
        transition-property: opacity;
        transition-duration: 150ms;
      }
      .auth-close:hover {
        opacity: 1;
      }
      .auth-close:focus {
        box-shadow: 0 0 0 2px hsl(var(--ring)), 0 0 0 4px hsl(var(--background));
      }
      .auth-close-icon {
        width: 1rem;
        height: 1rem;
        display: block;
        pointer-events: none;
      }
      .auth-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }
      .auth-header {
        display: flex;
        flex-direction: column;
        padding: 0;
        text-align: center;
      }
      .auth-title {
        margin: 0;
        color: hsl(var(--foreground));
        font-size: 1.125rem;
        font-weight: 600;
        line-height: 1.75rem;
        letter-spacing: -0.025em;
      }
      .auth-description {
        margin: 0.375rem 0 0;
        color: hsl(var(--muted-foreground));
        font-size: 0.875rem;
        line-height: 1.25rem;
      }
      .auth-form {
        margin: 0;
        display: block;
      }
      .auth-field {
        display: block;
      }
      .auth-form > * + * {
        margin-top: 1rem;
      }
      .auth-field > * + * {
        margin-top: 0.5rem;
      }
      .auth-label {
        color: hsl(var(--foreground));
        display: inline;
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1;
      }
      .auth-input {
        display: flex;
        width: 100%;
        height: 2.25rem;
        border: 1px solid hsl(var(--input));
        border-radius: 0;
        background: transparent;
        color: hsl(var(--foreground));
        padding: 0.25rem 0.75rem;
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        box-shadow: 0 0 #0000, 0 0 #0000, 0 1px 2px 0 rgb(0 0 0 / 0.05);
        outline: none;
        transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
        transition-duration: 150ms;
      }
      .auth-input::placeholder {
        color: hsl(var(--muted-foreground));
      }
      .auth-input:focus-visible {
        border-color: hsl(var(--ring));
      }
      .auth-input:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .auth-actions {
        display: flex;
        flex-direction: column-reverse;
      }
      .auth-button {
        outline: none;
        white-space: nowrap;
        transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
        transition-duration: 150ms;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        justify-content: center;
        height: 2.25rem;
        border: 0;
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
        cursor: pointer;
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        padding: 0.5rem 1rem;
        box-shadow: 0 0 #0000, 0 0 #0000, 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
      }
      .auth-button:hover {
        background: hsl(var(--primary) / 0.9);
      }
      .auth-button:focus-visible {
        box-shadow: 0 0 0 1px hsl(var(--ring)), 0 0 0 5px hsl(var(--background)), 0 0 0 6px hsl(var(--ring)), 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
      }
      @media (min-width: 640px) {
        .auth-panel {
          border-width: 1px;
          max-width: 36rem;
        }
        .auth-header {
          text-align: left;
        }
        .auth-actions {
          flex-direction: row;
          justify-content: flex-end;
        }
        .auth-actions > * + * {
          margin-left: 0.5rem;
        }
      }`;

function localLogoDataUrl() {
  return `data:image/png;base64,${fs.readFileSync(new URL('../assets/curve-labs-logo.png', import.meta.url)).toString('base64')}`;
}

function localSuccessPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ThinkFeel Key Set-Up</title>
    <style>${loginHtmlStyles}</style>
  </head>
  <body>
    <img class="auth-logo" src="${localLogoDataUrl()}" alt="Curve Labs" />
    <main class="auth-panel">
      <button class="auth-close" type="button" aria-label="Close" onclick="window.close()">
        <svg class="auth-close-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
        <span class="auth-sr-only">Close</span>
      </button>
      <div class="auth-header">
          <h1 class="auth-title">Create API key</h1>
          <p class="auth-description">ThinkFeel key setup is complete.<br />You can close this tab.</p>
        </div>
      <div class="auth-form">
        <div class="auth-field">
          <label class="auth-label" for="displayName">Status 200</label>
          <input class="auth-input" disabled id="displayName" name="name" value="Successfully completed." />
        </div>
        <div class="auth-actions">
          <button class="auth-button" type="button" onclick="window.close()">Done</button>
        </div>
      </div>
    </main>
    <p class="auth-warning">Do not authenticate this request if you did not initiate it.</p>
  </body>
</html>`;
}

function getLoginSource(args) {
  const source = args.source?.trim().toLowerCase() || 'codex';
  if (LOGIN_SOURCE_VALUES.has(source)) return source;
  fail('Invalid --source. Use codex or claude_code.');
}

function resolveOutputDir(rawDir) {
  if (!rawDir) return fs.mkdtempSync(path.join(os.tmpdir(), 'thinkfeel-playground-'));
  const dir = path.resolve(rawDir);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  chmodBestEffort(dir, 0o700);
  return dir;
}

function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

function unlinkBestEffort(target) {
  try {
    fs.unlinkSync(target);
  } catch {}
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

  if (!stat.isDirectory()) fail(`${label} is not a directory: ${filePath}`);
}

function resolveSafeTarget(targetPath, workspacePath) {
  const workspace = path.resolve(workspacePath);
  statDirectoryOrFail(workspace, 'Workspace');
  const workspaceRealPath = realpathSyncOrFail(workspace, 'workspace');
  const resolvedTarget = path.resolve(workspace, targetPath);
  const parentPath = path.dirname(resolvedTarget);
  statDirectoryOrFail(parentPath, 'Target parent directory');
  const parentRealPath = realpathSyncOrFail(parentPath, 'target parent directory');
  const relative = path.relative(workspaceRealPath, parentRealPath);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail(`Target env file must be inside the workspace. Workspace: ${workspaceRealPath}. Target: ${resolvedTarget}`);

  return path.join(parentRealPath, path.basename(resolvedTarget));
}

function lstatTarget(filePath) {
  let stat;

  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Failed to inspect target env file: ${error.message}`);
  }

  if (stat.isSymbolicLink()) fail(`Refusing to write API key through symlink target: ${filePath}`);
  if (!stat.isFile()) fail(`Refusing to write API key to non-file target: ${filePath}`);
  if (stat.nlink > 1) fail(`Refusing to write API key to hard-linked target: ${filePath}`);
  return stat;
}

function openNoFollow(filePath, flags, mode, action) {
  try {
    return fs.openSync(filePath, flags | (fs.constants.O_NOFOLLOW ?? 0), mode);
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
    if (!fs.fstatSync(fd).isFile()) failure = `Refusing to read non-file target env file: ${filePath}`;
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

  const fd = openNoFollow(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
    'create temporary'
  );

  let failure = null;

  try {
    if (!fs.fstatSync(fd).isFile()) failure = `Refusing to write API key to non-file temporary target: ${tempPath}`;
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

async function generateRecipientKeyPair() {
  const { privateKey, publicKey } = await subtle.generateKey(
    { hash: 'SHA-256', name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([0x01, 0x00, 0x01]) },
    true,
    ['encrypt', 'decrypt']
  );

  const { n, e } = await subtle.exportKey('jwk', publicKey);
  return { privateKey, publicJwk: { n, e, kty: 'RSA' } };
}

async function prepare(args) {
  const name = args.name?.trim() || 'ThinkFeel Plugin';
  const outputDir = resolveOutputDir(args.dir);
  const privateKeyPath = path.join(outputDir, 'recipient-private-key.jwk.json');
  const requestPath = path.join(outputDir, 'connector-request.json');
  const { privateKey, publicJwk } = await generateRecipientKeyPair();
  writeJson(privateKeyPath, await subtle.exportKey('jwk', privateKey));
  writeJson(requestPath, { name, recipient_public_key_jwk: publicJwk });
  printJson({ name, request_path: requestPath, private_key_path: privateKeyPath, recipient_public_key_jwk: publicJwk });
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

async function decryptPayload(privateKey, encryptedPayload) {
  if (encryptedPayload.version !== ENCRYPTED_API_KEY_VERSION)
    fail(`Unsupported encrypted API key version: ${encryptedPayload.version}`);

  const { ciphertext } = encryptedPayload;
  if (typeof ciphertext !== 'string') fail('Encrypted API key ciphertext is missing.');
  if (!/^[A-Za-z0-9_-]+$/.test(ciphertext) || ciphertext.length % 4 === 1) fail('Encrypted ciphertext must be base64url.');

  try {
    return new TextDecoder().decode(
      await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, Buffer.from(ciphertext, 'base64url'))
    );
  } catch {
    fail('Failed to decrypt encrypted API key.');
  }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, error => {
    if (error) process.stderr.write(`Open this URL in your browser:\n${url}\n`);
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
  let resolveCallback;
  let rejectCallback;

  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  return new Promise((resolve, reject) => {
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
        response.end(localSuccessPage());
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

    server.listen(0, '127.0.0.1', () =>
      resolve({ callbackPromise, redirectUri: `http://127.0.0.1:${server.address().port}/thinkfeel/callback` })
    );
  });
}

function upsertEnvValue(targetPath, envName, value, workspacePath) {
  const resolvedTarget = resolveSafeTarget(targetPath, workspacePath);
  const existed = lstatTarget(resolvedTarget) != null;
  const original = existed ? readFileNoFollow(resolvedTarget) : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const envPattern = new RegExp(`^(export\\s+)?${envName}=`);
  let updatedExisting = false;

  const updatedLines = (original.length > 0 ? original.split(/\r?\n/) : []).map(line => {
    const match = line.match(envPattern);
    if (!match) return line;
    updatedExisting = true;
    return `${match[1] ?? ''}${envName}=${value}`;
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
  const personaId = args['persona-id']?.trim();
  if (!personaId) return null;
  if (personaId.length > 255 || /[\r\n\0]/.test(personaId)) fail('Persona ID is not a safe env literal.');
  if (!/^[A-Za-z0-9._:-]+$/.test(personaId)) fail('Persona ID contains unsupported characters.');
  return personaId;
}

function writeEnv(args, apiKey, personaId, extra) {
  const envName = args['env-name']?.trim() || 'THINKFEEL_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) fail(`Invalid env var name: ${envName}`);

  if (!/^(sk-[A-Za-z0-9_-]+|tf[_-][A-Za-z0-9_-]+)$/.test(apiKey))
    fail('Decrypted API key is not a safe ThinkFeel/OpenAI API key literal.');

  const workspacePath = args.workspace?.trim() || process.cwd();
  const writeResult = upsertEnvValue(args.target, envName, apiKey, workspacePath);
  const personaWriteResult = personaId && upsertEnvValue(args.target, 'THINKFEEL_PERSONA_ID', personaId, workspacePath);
  printJson({
    ...writeResult,
    persona_env_name: personaWriteResult?.env_name,
    persona_target_path: personaWriteResult?.target_path,
    ...extra,
    wrote_plaintext_to_stdout: false,
  });
}

async function decrypt(args) {
  if (typeof args['private-key'] !== 'string') fail('Missing --private-key.');
  if (typeof args.target !== 'string') fail('Missing --target.');
  const personaId = getPersonaId(args);
  const encryptedPayload = encryptedPayloadFromArgs(args);

  const privateKey = await subtle.importKey(
    'jwk',
    readJson(path.resolve(args['private-key']), 'private key JWK'),
    { hash: 'SHA-256', name: 'RSA-OAEP' },
    false,
    ['decrypt']
  );

  writeEnv(args, await decryptPayload(privateKey, encryptedPayload), personaId);
}

async function login(args) {
  if (typeof args.target !== 'string') fail('Missing --target.');
  const source = getLoginSource(args);
  const name = args.name?.trim() || LOGIN_SOURCE_DISPLAY_NAMES[source];
  const personaId = getPersonaId(args);
  const state = randomUUID();
  const { privateKey, publicJwk } = await generateRecipientKeyPair();
  const { callbackPromise, redirectUri } = await startLoginCallbackServer(state);

  const loginUrl = new URL(
    '/api/thinkfeel/cli/login',
    (args['base-url']?.trim() || 'https://playground.curvelabs.org').replace(/\/+$/, '')
  );

  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('name', name);
  loginUrl.searchParams.set('source', source);
  loginUrl.searchParams.set('redirect_uri', redirectUri);
  loginUrl.searchParams.set('recipient_public_key_jwk', Buffer.from(JSON.stringify(publicJwk), 'utf8').toString('base64url'));
  openBrowser(loginUrl.toString());
  writeEnv(args, await decryptPayload(privateKey, await callbackPromise), personaId, { source });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command == null || command === '--help' || command === '-h') return process.stdout.write(`${USAGE}\n`);
  const args = parseArgs(rest);
  if (command === 'prepare') return prepare(args);
  if (command === 'login') return login(args);
  if (command === 'decrypt') return decrypt(args);
  fail(`Unknown command: ${command}\n${USAGE}`);
}

main().catch(error => {
  process.stderr.write(`thinkfeel-playground-api-key failed: ${error.message}\n`);
  process.exit(1);
});

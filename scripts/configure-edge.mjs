import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const runtimeDir = join(root, 'runtime');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseEnv(text) {
  const entries = [];
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(raw);
    if (!match) fail(`Unsupported .env line: ${raw}`);
    const [, key, value] = match;
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) fail(`Unsafe value for ${key}`);
    entries.push(key);
    values.set(key, value);
  }
  return { entries, values };
}

function validEmail(value) {
  return value.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value);
}

function validPublicHost(value) {
  if (value.length > 253 || value !== value.toLowerCase()) return false;
  if (value === 'localhost' || /^\d+(?:\.\d+){3}$/.test(value)) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function validEdgeUser(value) {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

function yamlString(value) {
  return JSON.stringify(value);
}

async function readState() {
  let text;
  try { text = await readFile(envPath, 'utf8'); }
  catch { fail('Missing .env. Run ./clientops setup first.'); }
  return parseEnv(text);
}

async function writeState(state) {
  const keys = [...state.entries];
  for (const key of state.values.keys()) if (!keys.includes(key)) keys.push(key);
  const text = keys.map((key) => `${key}=${state.values.get(key) ?? ''}`).join('\n') + '\n';
  const tmp = `${envPath}.next-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
  await chmod(tmp, 0o600);
  await rename(tmp, envPath);
}

function setValue(state, key, value) {
  if (!state.values.has(key)) state.entries.push(key);
  state.values.set(key, value);
}

function requireRuntimeState(state) {
  const required = [
    'CLIENTOPS_EDGE_MODE', 'CLIENTOPS_PUBLIC_HOST', 'CLIENTOPS_PUBLIC_ORIGIN',
    'CLIENTOPS_EDGE_BIND_HTTP', 'CLIENTOPS_EDGE_BIND_HTTPS',
    'CLIENTOPS_EDGE_USER', 'CLIENTOPS_EDGE_PASSWORD',
  ];
  for (const key of required) if (!state.values.get(key)) fail(`Missing ${key}; rerun ./clientops setup or ./clientops set-local.`);
  const mode = state.values.get('CLIENTOPS_EDGE_MODE');
  if (!['local', 'public'].includes(mode)) fail('CLIENTOPS_EDGE_MODE must be local or public.');
  if (!validEdgeUser(state.values.get('CLIENTOPS_EDGE_USER'))) fail('CLIENTOPS_EDGE_USER contains unsupported characters.');
  if (!/^[0-9a-f]{64}$/.test(state.values.get('CLIENTOPS_EDGE_PASSWORD'))) fail('CLIENTOPS_EDGE_PASSWORD must be the generated 64-character lowercase-hex secret.');
  if (mode === 'local') {
    if (state.values.get('CLIENTOPS_PUBLIC_HOST') !== 'localhost') fail('Local mode requires CLIENTOPS_PUBLIC_HOST=localhost.');
    if (state.values.get('CLIENTOPS_PUBLIC_ORIGIN') !== 'https://localhost:8443') fail('Local mode requires the canonical loopback HTTPS origin.');
    if (state.values.get('CLIENTOPS_EDGE_BIND_HTTP') !== '127.0.0.1:8080' || state.values.get('CLIENTOPS_EDGE_BIND_HTTPS') !== '127.0.0.1:8443') {
      fail('Local mode must bind the edge only to 127.0.0.1.');
    }
  } else {
    const host = state.values.get('CLIENTOPS_PUBLIC_HOST');
    const email = state.values.get('CLIENTOPS_ACME_EMAIL') ?? '';
    if (!validPublicHost(host)) fail('Public mode requires a lowercase DNS hostname, not localhost or an IP address.');
    if (!validEmail(email)) fail('Public mode requires a valid ACME contact email.');
    if (state.values.get('CLIENTOPS_PUBLIC_ORIGIN') !== `https://${host}`) fail('CLIENTOPS_PUBLIC_ORIGIN must exactly match the public HTTPS host.');
    if (state.values.get('CLIENTOPS_EDGE_BIND_HTTP') !== '0.0.0.0:80' || state.values.get('CLIENTOPS_EDGE_BIND_HTTPS') !== '0.0.0.0:443') {
      fail('Public mode must use the canonical 80/443 edge bindings.');
    }
  }
  return mode;
}

async function render() {
  const state = await readState();
  const mode = requireRuntimeState(state);
  const host = state.values.get('CLIENTOPS_PUBLIC_HOST');
  const user = state.values.get('CLIENTOPS_EDGE_USER');
  const password = state.values.get('CLIENTOPS_EDGE_PASSWORD');
  const sha = createHash('sha1').update(password, 'utf8').digest('base64');

  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await writeFile(join(runtimeDir, 'edge-users'), `${user}:{SHA}${sha}\n`, { mode: 0o644 });
  await chmod(join(runtimeDir, 'edge-users'), 0o644);

  const acme = mode === 'public' ? `\ncertificatesResolvers:\n  letsencrypt:\n    acme:\n      email: ${yamlString(state.values.get('CLIENTOPS_ACME_EMAIL'))}\n      storage: /var/lib/traefik/acme.json\n      httpChallenge:\n        entryPoint: web\n` : '';
  const staticConfig = `global:\n  checkNewVersion: false\n  sendAnonymousUsage: false\ncore:\n  strictTLSOptions: true\napi:\n  dashboard: false\n  insecure: false\nlog:\n  level: INFO\naccessLog:\n  format: json\n  bufferingSize: 100\nentryPoints:\n  health:\n    address: ":8082"\n  web:\n    address: ":80"\n    http:\n      aliasHeadersStrategy: reject\n      sanitizePath: true\n      maxHeaderBytes: 65536\n      redirections:\n        entryPoint:\n          to: websecure\n          scheme: https\n          permanent: true\n  websecure:\n    address: ":443"\n    http:\n      aliasHeadersStrategy: reject\n      sanitizePath: true\n      maxHeaderBytes: 65536\nproviders:\n  file:\n    filename: /etc/traefik/dynamic.yml\n    watch: false\nping:\n  entryPoint: health\n${acme}`;

  const tlsBlock = mode === 'public' ? '        certResolver: letsencrypt' : '        options: default';
  const hsts = mode === 'public' ? '      stsSeconds: 31536000\n      stsIncludeSubdomains: false\n      stsPreload: false\n      forceSTSHeader: true\n' : '';
  const intakeRule = `Host(\`${host}\`) && Path(\`/webhook/clientops/leads\`)`;
  const adminWebhookRule = `Host(\`${host}\`) && Path(\`/webhook/clientops/leads/contacted\`)`;
  const editorRule = `Host(\`${host}\`)`;
  const dynamicConfig = `http:\n  routers:\n    clientops-intake:\n      rule: ${yamlString(intakeRule)}\n      entryPoints: [websecure]\n      service: n8n\n      priority: 120\n      middlewares: [security-headers, webhook-body-limit, webhook-rate-limit]\n      tls:\n${tlsBlock}\n    clientops-admin-webhook:\n      rule: ${yamlString(adminWebhookRule)}\n      entryPoints: [websecure]\n      service: n8n\n      priority: 120\n      middlewares: [security-headers, webhook-body-limit, admin-webhook-rate-limit]\n      tls:\n${tlsBlock}\n    clientops-editor:\n      rule: ${yamlString(editorRule)}\n      entryPoints: [websecure]\n      service: n8n\n      priority: 10\n      middlewares: [editor-auth, security-headers, editor-rate-limit]\n      tls:\n${tlsBlock}\n  middlewares:\n    editor-auth:\n      basicAuth:\n        usersFile: /run/secrets/clientops-edge-users\n        removeHeader: true\n        realm: ClientOps Relay\n    webhook-body-limit:\n      buffering:\n        maxRequestBodyBytes: 1048576\n        memRequestBodyBytes: 262144\n    webhook-rate-limit:\n      rateLimit:\n        average: 25\n        period: 1s\n        burst: 50\n    admin-webhook-rate-limit:\n      rateLimit:\n        average: 10\n        period: 1s\n        burst: 20\n    editor-rate-limit:\n      rateLimit:\n        average: 30\n        period: 1s\n        burst: 60\n    security-headers:\n      headers:\n        contentTypeNosniff: true\n        frameDeny: true\n        referrerPolicy: no-referrer\n${hsts}        customResponseHeaders:\n          X-Robots-Tag: "noindex, nofollow, noarchive"\n          X-Content-Type-Options: nosniff\ntls:\n  options:\n    default:\n      minVersion: VersionTLS12\n  services:\n    n8n:\n      loadBalancer:\n        passHostHeader: true\n        servers:\n          - url: http://n8n:5678\n`;

  await writeFile(join(runtimeDir, 'traefik.yml'), staticConfig, { mode: 0o644 });
  await writeFile(join(runtimeDir, 'edge-dynamic.yml'), dynamicConfig, { mode: 0o644 });
  await chmod(join(runtimeDir, 'traefik.yml'), 0o644);
  await chmod(join(runtimeDir, 'edge-dynamic.yml'), 0o644);
  process.stdout.write(JSON.stringify({ status: 'rendered', mode, host, origin: state.values.get('CLIENTOPS_PUBLIC_ORIGIN') }, null, 2) + '\n');
}

async function setPublic(host, email) {
  if (!validPublicHost(host ?? '')) fail('Host must be a lowercase public DNS name such as relay.example.org.');
  if (!validEmail(email ?? '')) fail('ACME email is invalid.');
  const state = await readState();
  setValue(state, 'CLIENTOPS_EDGE_MODE', 'public');
  setValue(state, 'CLIENTOPS_PUBLIC_HOST', host);
  setValue(state, 'CLIENTOPS_PUBLIC_ORIGIN', `https://${host}`);
  setValue(state, 'CLIENTOPS_ACME_EMAIL', email);
  setValue(state, 'CLIENTOPS_EDGE_BIND_HTTP', '0.0.0.0:80');
  setValue(state, 'CLIENTOPS_EDGE_BIND_HTTPS', '0.0.0.0:443');
  await writeState(state);
  await render();
}

async function setLocal() {
  const state = await readState();
  setValue(state, 'CLIENTOPS_EDGE_MODE', 'local');
  setValue(state, 'CLIENTOPS_PUBLIC_HOST', 'localhost');
  setValue(state, 'CLIENTOPS_PUBLIC_ORIGIN', 'https://localhost:8443');
  setValue(state, 'CLIENTOPS_ACME_EMAIL', '');
  setValue(state, 'CLIENTOPS_EDGE_BIND_HTTP', '127.0.0.1:8080');
  setValue(state, 'CLIENTOPS_EDGE_BIND_HTTPS', '127.0.0.1:8443');
  await writeState(state);
  await render();
}

const [command, ...args] = process.argv.slice(2);
if (command === 'render') await render();
else if (command === 'set-public') await setPublic(args[0], args[1]);
else if (command === 'set-local') await setLocal();
else fail('Usage: node scripts/configure-edge.mjs render | set-public HOST EMAIL | set-local');

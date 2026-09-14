import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const companion = resolve(root, 'companion/server.mjs');
const policyDirectory = resolve(root, 'policy-engine');
const binary = resolve(process.argv[2] ?? resolve(policyDirectory, 'build/policy_cli'));
const config = resolve(process.argv[3] ?? resolve(policyDirectory, 'config/policy.json'));
const apiKey = 'a'.repeat(64);

const build = spawnSync('make', ['-C', policyDirectory, 'all'], { encoding: 'utf8' });
assert.equal(build.status, 0, `real policy build failed:\n${build.stdout}\n${build.stderr}`);

const port = await reservePort();
const child = spawn(process.execPath, [companion], {
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOST: '127.0.0.1',
    PORT: String(port),
    POLICY_BINARY: binary,
    POLICY_CONFIG: config,
    CLIENTOPS_COMPANION_API_KEY: apiKey,
    ...(process.env.ASAN_OPTIONS ? { ASAN_OPTIONS: process.env.ASAN_OPTIONS } : {}),
    ...(process.env.UBSAN_OPTIONS ? { UBSAN_OPTIONS: process.env.UBSAN_OPTIONS } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });

const baseUrl = `http://127.0.0.1:${port}`;
const validRequest = {
  leadId: 'companion-contract',
  channel: 'webhook',
  name: 'Jordan Lee',
  email: 'jordan@example.test',
  source: 'companion-test',
  message: 'Our account has a critical issue and we need support today.',
  consent: true,
};
let responseSha256;

try {
  const health = await waitForJson('/healthz');
  assert.deepEqual(health, { ok: true, service: 'clientops-companion', status: 'live' });

  const readyResponse = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ok: true,
    service: 'clientops-companion',
    status: 'ready',
    policyVersion: 'clientops-triage-v1',
  });

  const missingKey = await post(validRequest);
  assert.equal(missingKey.status, 401);
  assert.equal((await missingKey.json()).error.code, 'unauthorized');

  const wrongKey = await post(validRequest, 'b'.repeat(64));
  assert.equal(wrongKey.status, 401);

  const malformedKey = await post(validRequest, `${apiKey},${apiKey}`);
  assert.equal(malformedKey.status, 401);

  const deterministicBodies = [];
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const response = await post(validRequest, apiKey);
    assert.equal(response.status, 200);
    deterministicBodies.push(await response.text());
  }
  assert.equal(new Set(deterministicBodies).size, 1, 'companion responses must be byte-identical');
  responseSha256 = createHash('sha256').update(deterministicBodies[0]).digest('hex');
  const qualified = JSON.parse(deterministicBodies[0]);
  assert.deepEqual(Object.keys(qualified).sort(), ['decision', 'lead', 'ok', 'policyVersion']);
  assert.deepEqual(Object.keys(qualified.lead).sort(), ['channel', 'city', 'consent', 'email', 'leadId', 'message', 'name', 'phone', 'source']);
  assert.deepEqual(Object.keys(qualified.decision).sort(), ['category', 'draftReply', 'fit', 'fitReason', 'nextStep', 'route', 'score', 'serviceable', 'summary', 'urgency']);
  assert.equal(qualified.ok, true);
  assert.equal(qualified.policyVersion, 'clientops-triage-v1');
  assert.equal(qualified.decision.category, 'support');
  assert.equal(qualified.decision.route, 'ROUTE_URGENT');

  const invalid = await post({ ...validRequest, consent: false }, apiKey);
  assert.equal(invalid.status, 422);
  const invalidBody = await invalid.json();
  assert.deepEqual(Object.keys(invalidBody).sort(), ['error', 'ok']);
  assert.deepEqual(Object.keys(invalidBody.error).sort(), ['code', 'message']);
  assert.equal(invalidBody.error.code, 'validation_error');

  for (const acceptedContentType of ['application/json; charset=utf-8', 'application/json; charset="utf-8"']) {
    const accepted = await post(validRequest, apiKey, acceptedContentType);
    assert.equal(accepted.status, 200, `${acceptedContentType} should be accepted`);
  }

  const mediaType = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: { 'x-clientops-companion-key': apiKey },
    body: '{}',
  });
  assert.equal(mediaType.status, 415);

  for (const rejectedContentType of ['application/json;', 'application/json; charset=iso-8859-1', 'application/json; profile=test']) {
    const rejected = await post(validRequest, apiKey, rejectedContentType);
    assert.equal(rejected.status, 415, `${rejectedContentType} should be rejected`);
  }

  const lookalikeMediaType = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/jsonp',
      'x-clientops-companion-key': apiKey,
    },
    body: '{}',
  });
  assert.equal(lookalikeMediaType.status, 415);

  const invalidUtf8 = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-clientops-companion-key': apiKey,
    },
    body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  });
  assert.equal(invalidUtf8.status, 422);
  assert.equal((await invalidUtf8.json()).error.code, 'invalid_json');

  const routeCases = new Map([
    ['buy backlinks now', ['spam', 'ROUTE_SPAM']],
    ['Please call.', ['unknown', 'ROUTE_INSUFFICIENT_INFORMATION']],
    ['employment application for your team', ['unsupported', 'ROUTE_UNSUPPORTED']],
    ['I need a quote for pricing', ['sales', 'ROUTE_STANDARD']],
    ['I have a support problem', ['support', 'ROUTE_SPECIALIST']],
    ['urgent support outage today', ['support', 'ROUTE_URGENT']],
    ['pricing support problem', ['ambiguous', 'ROUTE_MANUAL_REVIEW']],
  ]);
  for (const [message, [category, route]] of routeCases) {
    const routed = await post({ ...validRequest, message }, apiKey);
    assert.equal(routed.status, 200);
    const routedBody = await routed.json();
    assert.equal(routedBody.decision.category, category);
    assert.equal(routedBody.decision.route, route);
  }

  const oversized = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-clientops-companion-key': apiKey,
    },
    body: JSON.stringify({ message: 'x'.repeat(33 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'payload_too_large');

  const wrongMethod = await fetch(`${baseUrl}/v2/qualify`, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  const unknown = await fetch(`${baseUrl}/v2/proxy`);
  assert.equal(unknown.status, 404);

  for (const endpoint of ['/healthz', '/readyz', '/v2/qualify']) {
    const response = endpoint === '/v2/qualify'
      ? await post(validRequest, 'c'.repeat(64))
      : await fetch(`${baseUrl}${endpoint}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/u);
  }
} finally {
  child.kill('SIGTERM');
  await waitForExit(child);
}

assert(!stdout.includes(apiKey), 'API key leaked to stdout');
assert(!stderr.includes(apiKey), 'API key leaked to stderr');
assert.equal(stderr, '', `companion emitted unexpected stderr: ${stderr}`);

await assertStartupRejects('', /CLIENTOPS_COMPANION_API_KEY/u);
await assertStartupRejects('short', /CLIENTOPS_COMPANION_API_KEY/u);
await assertPolicyStartupRejects({
  POLICY_CONFIG: resolve(root, 'tests/fixtures/companion-config-does-not-exist.json'),
}, /policy readiness probe failed/u);
await assertCustomCategoryAccepted();

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  contract: 'deployment-companion',
  endpoint: '/v2/qualify',
  policy: 'real compiled subprocess',
  deterministicRepetitions: 20,
  responseSha256,
  observedStatuses: [200, 401, 404, 405, 413, 415, 422],
}, null, 2)}\n`);

function appendBounded(current, chunk) {
  return `${current}${chunk}`.slice(-16 * 1024);
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const { port: reserved } = reservation.address();
  await new Promise((resolveClose, reject) => {
    reservation.close((error) => error ? reject(error) : resolveClose());
  });
  return reserved;
}

async function waitForJson(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`companion exited early (${child.exitCode}): ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}${path}`);
      if (response.ok) return response.json();
    } catch {
      // The child has not bound the reserved port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`companion did not become ready: ${stderr}`);
}

function post(body, key, contentType = 'application/json') {
  return fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      ...(key === undefined ? {} : { 'x-clientops-companion-key': key }),
    },
    body: JSON.stringify(body),
  });
}

function waitForExit(processToWait) {
  return new Promise((resolveExit) => {
    if (processToWait.exitCode !== null || processToWait.signalCode !== null) resolveExit();
    else processToWait.once('exit', resolveExit);
  });
}

async function assertStartupRejects(key, expected) {
  const rejected = spawn(process.execPath, [companion], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOST: '127.0.0.1',
      PORT: String(await reservePort()),
      POLICY_BINARY: binary,
      POLICY_CONFIG: config,
      ...(key === '' ? {} : { CLIENTOPS_COMPANION_API_KEY: key }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let rejectedStderr = '';
  rejected.stderr.setEncoding('utf8');
  rejected.stderr.on('data', (chunk) => { rejectedStderr = appendBounded(rejectedStderr, chunk); });
  await waitForExit(rejected);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejectedStderr, expected);
  assert(!rejectedStderr.includes(apiKey));
}

async function assertPolicyStartupRejects(overrides, expected) {
  const rejected = spawn(process.execPath, [companion], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOST: '127.0.0.1',
      PORT: String(await reservePort()),
      POLICY_BINARY: binary,
      POLICY_CONFIG: config,
      CLIENTOPS_COMPANION_API_KEY: apiKey,
      ...(process.env.ASAN_OPTIONS ? { ASAN_OPTIONS: process.env.ASAN_OPTIONS } : {}),
      ...(process.env.UBSAN_OPTIONS ? { UBSAN_OPTIONS: process.env.UBSAN_OPTIONS } : {}),
      ...overrides,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let rejectedStderr = '';
  rejected.stderr.setEncoding('utf8');
  rejected.stderr.on('data', (chunk) => { rejectedStderr = appendBounded(rejectedStderr, chunk); });
  await waitForExit(rejected);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejectedStderr, expected);
  assert(!rejectedStderr.includes(apiKey), 'API key leaked during readiness failure');
}

async function assertCustomCategoryAccepted() {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'clientops-custom-category-'));
  const customConfigPath = resolve(temporaryDirectory, 'policy.json');
  const customConfig = JSON.parse(readFileSync(config, 'utf8'));
  customConfig.categories = [{ name: 'billing_ops', specialist: false, keywords: ['invoice'] }];
  customConfig.fallback_category = 'billing_ops';
  writeFileSync(customConfigPath, `${JSON.stringify(customConfig)}\n`, { mode: 0o600 });

  const customPort = await reservePort();
  const customChild = spawn(process.execPath, [companion], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOST: '127.0.0.1',
      PORT: String(customPort),
      POLICY_BINARY: binary,
      POLICY_CONFIG: customConfigPath,
      CLIENTOPS_COMPANION_API_KEY: apiKey,
      ...(process.env.ASAN_OPTIONS ? { ASAN_OPTIONS: process.env.ASAN_OPTIONS } : {}),
      ...(process.env.UBSAN_OPTIONS ? { UBSAN_OPTIONS: process.env.UBSAN_OPTIONS } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let customStderr = '';
  customChild.stderr.setEncoding('utf8');
  customChild.stderr.on('data', (chunk) => { customStderr = appendBounded(customStderr, chunk); });
  try {
    const customBase = `http://127.0.0.1:${customPort}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const ready = await fetch(`${customBase}/readyz`);
        if (ready.ok) break;
      } catch {}
      if (customChild.exitCode !== null) throw new Error(`custom companion exited: ${customStderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const response = await fetch(`${customBase}/v2/qualify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clientops-companion-key': apiKey },
      body: JSON.stringify({ ...validRequest, message: 'Please review this invoice request.' }),
    });
    assert.equal(response.status, 200, `custom category response failed: ${customStderr}`);
    assert.equal((await response.json()).decision.category, 'billing_ops');
  } finally {
    customChild.kill('SIGTERM');
    await waitForExit(customChild);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assert.equal(customStderr, '');
}

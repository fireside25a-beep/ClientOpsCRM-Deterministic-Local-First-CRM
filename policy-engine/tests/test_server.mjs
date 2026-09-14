import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'build/policy_cli');
const config = resolve(process.argv[3] ?? 'config/policy.json');

const reservation = createServer();
await new Promise((resolveListen, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolveListen);
});
const { port } = reservation.address();
await new Promise((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()));

const child = spawn(process.execPath, [resolve('server.mjs')], {
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOST: '127.0.0.1',
    PORT: String(port),
    POLICY_BINARY: binary,
    POLICY_CONFIG: config,
    ...(process.env.ASAN_OPTIONS ? { ASAN_OPTIONS: process.env.ASAN_OPTIONS } : {}),
    ...(process.env.UBSAN_OPTIONS ? { UBSAN_OPTIONS: process.env.UBSAN_OPTIONS } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const baseUrl = `http://127.0.0.1:${port}`;
async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return response.json();
    } catch {
      // The child has not bound the port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(`policy HTTP service did not become ready: ${stderr}`);
}

try {
  const health = await waitForHealth();
  assert.deepEqual(health, { status: 'ok', policyVersion: 'clientops-triage-v1' });

  const request = {
    leadId: 'http-contract',
    channel: 'webhook',
    name: 'Jordan Lee',
    email: 'jordan@example.test',
    source: 'contract-test',
    message: 'Our account has a critical issue and we need support today.',
    consent: true,
  };
  const qualified = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(qualified.status, 200);
  const body = await qualified.json();
  assert.equal(body.policyVersion, 'clientops-triage-v1');
  assert.equal(body.decision.category, 'support');
  assert.equal(body.decision.route, 'ROUTE_URGENT');

  const invalid = await fetch(`${baseUrl}/v2/qualify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, consent: false }),
  });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, 'validation_error');

  const oldEndpoint = await fetch(`${baseUrl}/v1/legacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(oldEndpoint.status, 404);

  const mediaType = await fetch(`${baseUrl}/v2/qualify`, { method: 'POST', body: '{}' });
  assert.equal(mediaType.status, 415);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', resolveExit);
  });
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  contract: 'policy-http',
  endpoint: '/v2/qualify',
  statuses: [200, 422, 404, 415],
}, null, 2)}\n`);

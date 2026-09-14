import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const binary = process.env.POLICY_BINARY ?? '/app/policy_cli';
const config = process.env.POLICY_CONFIG ?? '/app/config/policy.json';
const maxBodyBytes = 32 * 1024;
const maxConcurrent = 32;
const timeoutMs = 2_000;
let inFlight = 0;

const versionProbe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
if (versionProbe.status !== 0) {
  throw new Error(`policy binary failed startup probe: ${versionProbe.stderr || versionProbe.stdout}`);
}
const policyVersion = versionProbe.stdout.trim();

function send(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(encoded);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function evaluate(payload) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    for (const variable of ['ASAN_OPTIONS', 'UBSAN_OPTIONS']) {
      if (process.env[variable]) childEnvironment[variable] = process.env[variable];
    }
    const child = spawn(binary, ['--config', config], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 128 * 1024) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 8 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(Object.assign(new Error('policy evaluation timed out'), { statusCode: 504 }));
        return;
      }
      if (stdoutBytes > 128 * 1024) {
        reject(new Error('policy response exceeded limit'));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new Error(`policy returned invalid JSON${stderr.length ? `: ${Buffer.concat(stderr).toString('utf8')}` : ''}`));
        return;
      }
      if (code === 0) {
        resolve({ status: 200, body: parsed });
      } else if (code === 2 || code === 64) {
        resolve({ status: 422, body: parsed });
      } else {
        reject(new Error(`policy process failed with exit code ${code}`));
      }
    });
    child.stdin.end(payload);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    send(res, 200, { status: 'ok', policyVersion });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v2/qualify') {
    send(res, 404, { ok: false, error: { code: 'not_found', message: 'Endpoint not found' } });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    send(res, 415, { ok: false, error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json' } });
    return;
  }
  if (inFlight >= maxConcurrent) {
    send(res, 503, { ok: false, error: { code: 'busy', message: 'Policy service is at its concurrency limit' } });
    return;
  }

  inFlight += 1;
  try {
    const payload = await collectBody(req);
    const result = await evaluate(payload);
    send(res, result.status, result.body);
  } catch (error) {
    if (!res.headersSent) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      send(res, status, {
        ok: false,
        error: {
          code: status === 413 ? 'payload_too_large' : status === 504 ? 'timeout' : 'policy_unavailable',
          message: status >= 500 ? 'Policy evaluation is temporarily unavailable' : error.message,
        },
      });
    }
  } finally {
    inFlight -= 1;
  }
});

server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => {
  process.stdout.write(`policy-api listening on ${host}:${port} (${policyVersion})\n`);
});

function shutdown() {
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';

const SERVICE_NAME = 'clientops-companion';
const API_PATH = '/v2/qualify';
const API_KEY_HEADER = 'x-clientops-companion-key';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CONCURRENT = 32;
const MAX_STDOUT_BYTES = 128 * 1024;
const PROCESS_TIMEOUT_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const READINESS_CACHE_MS = 2_000;

const host = process.env.HOST ?? '0.0.0.0';
const port = parsePort(process.env.PORT ?? '8080');
const binary = process.env.POLICY_BINARY ?? '/app/policy_cli';
const config = process.env.POLICY_CONFIG ?? '/app/config/policy.json';
const apiKey = process.env.CLIENTOPS_COMPANION_API_KEY ?? '';

if (!/^[a-f0-9]{64}$/u.test(apiKey)) {
  throw new Error('CLIENTOPS_COMPANION_API_KEY must contain exactly 64 lowercase hexadecimal characters');
}
if (!isAbsolute(binary) || !isAbsolute(config)) {
  throw new Error('POLICY_BINARY and POLICY_CONFIG must be absolute paths');
}

const expectedKeyDigest = digestSecret(apiKey);
const activeChildren = new Set();
let inFlight = 0;
let shuttingDown = false;
let readinessCheckedAt = 0;
let readinessPromise;

const policyVersion = await verifyPolicyReady();

const server = createServer(async (request, response) => {
  addSecurityHeaders(response);

  if (request.method === 'GET' && request.url === '/healthz') {
    sendJson(response, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      service: SERVICE_NAME,
      status: shuttingDown ? 'stopping' : 'live',
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/readyz') {
    if (shuttingDown) {
      sendUnavailable(response);
      return;
    }
    try {
      const currentVersion = await coalescedReadinessProbe();
      if (currentVersion !== policyVersion) throw new Error('policy version changed');
      sendJson(response, 200, {
        ok: true,
        service: SERVICE_NAME,
        status: 'ready',
        policyVersion,
      });
    } catch {
      sendUnavailable(response);
    }
    return;
  }

  if (request.url !== API_PATH) {
    sendError(response, 404, 'not_found', 'Endpoint not found');
    return;
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    sendError(response, 405, 'method_not_allowed', 'Method not allowed');
    return;
  }

  if (!isAuthenticated(request)) {
    sendError(response, 401, 'unauthorized', 'Valid companion credentials are required');
    return;
  }

  if (shuttingDown) {
    sendUnavailable(response);
    return;
  }

  const contentType = String(request.headers['content-type'] ?? '');
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/iu.test(contentType)) {
    sendError(response, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    return;
  }

  const contentLength = parseContentLength(request.headers['content-length']);
  if (contentLength === null) {
    sendError(response, 400, 'invalid_content_length', 'Content-Length is invalid');
    return;
  }
  if (contentLength > MAX_BODY_BYTES) {
    request.resume();
    sendError(response, 413, 'payload_too_large', 'Request body exceeds 32768 bytes');
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    sendError(response, 503, 'busy', 'Companion service is at its concurrency limit');
    return;
  }

  inFlight += 1;
  try {
    const payload = await collectBody(request);
    const result = await evaluatePolicy(payload);
    sendJson(response, result.status, result.body);
  } catch (error) {
    if (response.headersSent || response.writableEnded || response.destroyed) return;
    if (error?.code === 'PAYLOAD_TOO_LARGE') {
      sendError(response, 413, 'payload_too_large', 'Request body exceeds 32768 bytes');
    } else if (error?.code === 'INVALID_JSON_ENCODING') {
      sendError(response, 422, 'invalid_json', 'Request body must be valid UTF-8 JSON');
    } else if (error?.code === 'POLICY_TIMEOUT') {
      sendError(response, 504, 'policy_timeout', 'Policy evaluation timed out');
    } else {
      sendUnavailable(response);
    }
  } finally {
    inFlight -= 1;
  }
});

server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
});
process.stdout.write(`${SERVICE_NAME} listening on ${host}:${port} (${policyVersion})\n`);

process.on('SIGTERM', beginShutdown);
process.on('SIGINT', beginShutdown);

function parsePort(value) {
  if (!/^[0-9]{1,5}$/u.test(value)) throw new Error('PORT must be an integer from 1 through 65535');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return parsed;
}

function digestSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isAuthenticated(request) {
  const supplied = request.headers[API_KEY_HEADER];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied)) return false;
  return timingSafeEqual(digestSecret(supplied), expectedKeyDigest);
}

function parseContentLength(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function addSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { ok: false, error: { code, message } });
}

function sendUnavailable(response) {
  sendError(response, 503, 'policy_unavailable', 'Policy evaluation is temporarily unavailable');
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      if (!exceeded) chunks.push(chunk);
    });
    request.once('end', () => {
      if (exceeded) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
      } else {
        resolve(Buffer.concat(chunks, total));
      }
    });
    request.once('aborted', () => reject(new Error('request aborted')));
    request.once('error', reject);
  });
}

function childEnvironment() {
  const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const variable of ['ASAN_OPTIONS', 'UBSAN_OPTIONS']) {
    if (process.env[variable]) environment[variable] = process.env[variable];
  }
  return environment;
}

function executePolicy(arguments_, input, stdoutLimit = MAX_STDOUT_BYTES) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timedOut = false;
    let outputExceeded = false;
    let stdoutBytes = 0;
    const stdout = [];
    const child = spawn(binary, arguments_, {
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    activeChildren.add(child);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROCESS_TIMEOUT_MS);

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      callback();
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code, signal) => finish(() => {
      if (timedOut) {
        reject(Object.assign(new Error('policy process timed out'), { code: 'POLICY_TIMEOUT' }));
      } else if (outputExceeded) {
        reject(new Error('policy output exceeded its bound'));
      } else {
        resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8').trim() });
      }
    }));

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parsePolicyJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('policy returned invalid JSON');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('policy returned a non-object response');
  }
  return parsed;
}

async function evaluatePolicy(payload) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw Object.assign(new Error('invalid JSON encoding'), { code: 'INVALID_JSON_ENCODING' });
  }
  const result = await executePolicy(['--config', config], payload);
  const body = parsePolicyJson(result.stdout);
  if (result.code === 0 && validateSuccessBody(body, policyVersion)) {
    return { status: 200, body };
  }
  if ((result.code === 2 || result.code === 64) && validateErrorBody(body)) {
    return { status: 422, body };
  }
  throw new Error('policy returned an incompatible response');
}

async function verifyPolicyReady() {
  const versionResult = await executePolicy(['--version'], Buffer.alloc(0), 4 * 1024);
  if (versionResult.code !== 0 || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(versionResult.stdout)) {
    throw new Error('policy version probe failed');
  }

  const validationResult = await executePolicy(['--config', config], Buffer.from('{}'));
  const validation = parsePolicyJson(validationResult.stdout);
  if ((validationResult.code !== 2 && validationResult.code !== 64)
      || !validateErrorBody(validation)) {
    throw new Error('policy readiness probe failed');
  }
  return versionResult.stdout;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value, maximum, allowMessageControls = false) {
  if (typeof value !== 'string' || value.length > maximum || !value.isWellFormed()) return false;
  const forbidden = allowMessageControls
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  return !forbidden.test(value);
}

function validateSuccessBody(body, expectedVersion) {
  if (!hasExactKeys(body, ['ok', 'policyVersion', 'lead', 'decision'])
      || body.ok !== true || body.policyVersion !== expectedVersion) return false;

  const lead = body.lead;
  if (lead === null || Array.isArray(lead) || typeof lead !== 'object'
      || !hasExactKeys(lead, ['leadId', 'channel', 'name', 'city', 'phone', 'email', 'source', 'message', 'consent'])
      || lead.consent !== true) return false;
  const leadBounds = {
    leadId: 31, channel: 31, name: 159, city: 127, phone: 63,
    email: 255, source: 95, message: 8_191,
  };
  for (const [key, maximum] of Object.entries(leadBounds)) {
    if (!boundedString(lead[key], maximum, key === 'message')) return false;
  }

  const decision = body.decision;
  if (decision === null || Array.isArray(decision) || typeof decision !== 'object'
      || !hasExactKeys(decision, ['fit', 'fitReason', 'category', 'score', 'serviceable', 'urgency', 'summary', 'nextStep', 'draftReply', 'route'])
      || typeof decision.fit !== 'boolean' || typeof decision.serviceable !== 'boolean'
      || !Number.isInteger(decision.score) || decision.score < 0 || decision.score > 100) return false;
  if (typeof decision.category !== 'string' || !/^[a-z0-9_-]{1,63}$/u.test(decision.category)
      || !['low', 'medium', 'high'].includes(decision.urgency)
      || !['ROUTE_SPAM', 'ROUTE_INSUFFICIENT_INFORMATION', 'ROUTE_UNSUPPORTED', 'ROUTE_LOCATION_REVIEW', 'ROUTE_URGENT', 'ROUTE_SPECIALIST', 'ROUTE_STANDARD', 'ROUTE_MANUAL_REVIEW'].includes(decision.route)) return false;
  const decisionBounds = {
    fitReason: 1_023, category: 63, urgency: 15, summary: 1_023,
    nextStep: 511, draftReply: 4_095, route: 63,
  };
  return Object.entries(decisionBounds).every(([key, maximum]) => boundedString(decision[key], maximum));
}

function validateErrorBody(body) {
  if (!hasExactKeys(body, ['ok', 'error']) || body.ok !== false
      || body.error === null || Array.isArray(body.error) || typeof body.error !== 'object'
      || !hasExactKeys(body.error, ['code', 'message'])) return false;
  return ['usage_error', 'config_error', 'payload_too_large', 'invalid_json', 'validation_error', 'internal_error'].includes(body.error.code)
    && boundedString(body.error.message, 511);
}

function coalescedReadinessProbe() {
  const now = Date.now();
  if (readinessPromise && now - readinessCheckedAt < READINESS_CACHE_MS) return readinessPromise;
  readinessCheckedAt = now;
  readinessPromise = verifyPolicyReady();
  return readinessPromise;
}

function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => process.exit(error ? 1 : 0));
  for (const child of activeChildren) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of activeChildren) child.kill('SIGKILL');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

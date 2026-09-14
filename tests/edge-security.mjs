import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'clientops-edge-test-'));
const run = (args) => spawnSync(join(sandbox, 'clientops'), args, {
  cwd: sandbox,
  encoding: 'utf8',
  env: { ...process.env },
});
const sha = (text) => createHash('sha256').update(text).digest('hex');

function assertLocalDynamic(text) {
  assert.match(text, /Host\(`localhost`\) && Path\(`\/webhook\/clientops\/leads`\)/);
  assert.match(text, /Host\(`localhost`\) && Path\(`\/webhook\/clientops\/leads\/contacted`\)/);
  assert.doesNotMatch(text, /PathPrefix\(`\/webhook\//, 'arbitrary n8n webhook paths must not be public');
  assert.match(text, /clientops-editor:[\s\S]*?middlewares: \[editor-auth, security-headers, editor-rate-limit\]/);
  assert.match(text, /basicAuth:[\s\S]*?removeHeader: true/);
  assert.match(text, /webhook-body-limit:[\s\S]*?maxRequestBodyBytes: 1048576/);
  assert.match(text, /webhook-rate-limit:[\s\S]*?average: 25[\s\S]*?burst: 50/);
  assert.match(text, /admin-webhook-rate-limit:[\s\S]*?average: 10[\s\S]*?burst: 20/);
  assert.match(text, /editor-rate-limit:[\s\S]*?average: 30[\s\S]*?burst: 60/);
  assert.match(text, /contentTypeNosniff: true/);
  assert.match(text, /frameDeny: true/);
  assert.match(text, /referrerPolicy: no-referrer/);
  assert.match(text, /tls:\n  options:\n    default:\n      minVersion: VersionTLS12/);
}


function assertStaticHardening(text) {
  assert.match(text, /strictTLSOptions: true/);
  assert.equal((text.match(/aliasHeadersStrategy: reject/g) ?? []).length, 2);
  assert.equal((text.match(/sanitizePath: true/g) ?? []).length, 2);
  assert.equal((text.match(/maxHeaderBytes: 65536/g) ?? []).length, 2);
  assert.doesNotMatch(text, /forwardedHeaders:\n[\s\S]*?insecure: true/);
  assert.match(text, /dashboard: false/);
  assert.match(text, /insecure: false/);
  assert.match(text, /providers:\n  file:/);
  assert.doesNotMatch(text, /providers:\n[\s\S]*?docker:/);
}

function assertDynamicHardening(text) {
  assertLocalDynamic(text.replaceAll('relay.example.com', 'localhost').replaceAll('certResolver: letsencrypt', 'options: default'));
  assert.match(text, /minVersion: VersionTLS12/);
  assert.match(text, /maxRequestBodyBytes: 1048576/);
  assert.match(text, /memRequestBodyBytes: 262144/);
  assert.match(text, /clientops-intake:[\s\S]*?middlewares: \[security-headers, webhook-body-limit, webhook-rate-limit\]/);
  assert.match(text, /clientops-admin-webhook:[\s\S]*?middlewares: \[security-headers, webhook-body-limit, admin-webhook-rate-limit\]/);
  assert.match(text, /editor-auth:[\s\S]*?basicAuth:/);
  assert.match(text, /removeHeader: true/);
  assert.match(text, /webhook-rate-limit:[\s\S]*?average: 25[\s\S]*?burst: 50/);
  assert.match(text, /admin-webhook-rate-limit:[\s\S]*?average: 10[\s\S]*?burst: 20/);
  assert.match(text, /editor-rate-limit:[\s\S]*?average: 30[\s\S]*?burst: 60/);
  assert.doesNotMatch(text, /PathPrefix\(`\/webhook\//);
}

function rejectMutants(staticText, dynamicText) {
  const mutants = [
    ['strict TLS fallback', staticText.replace('strictTLSOptions: true', 'strictTLSOptions: false'), dynamicText],
    ['header alias acceptance', staticText.replaceAll('aliasHeadersStrategy: reject', 'aliasHeadersStrategy: keep'), dynamicText],
    ['unsafe path handling', staticText.replaceAll('sanitizePath: true', 'sanitizePath: false'), dynamicText],
    ['oversized headers', staticText.replaceAll('maxHeaderBytes: 65536', 'maxHeaderBytes: 1048576'), dynamicText],
    ['insecure forwarded headers', staticText.replace('    http:\n      aliasHeadersStrategy: reject', '    forwardedHeaders:\n      insecure: true\n    http:\n      aliasHeadersStrategy: reject'), dynamicText],
    ['dashboard exposure', staticText.replace('dashboard: false', 'dashboard: true'), dynamicText],
    ['docker provider insertion', staticText.replace('providers:\n  file:', 'providers:\n  docker: {}\n  file:'), dynamicText],
    ['TLS 1.0 downgrade', staticText, dynamicText.replace('minVersion: VersionTLS12', 'minVersion: VersionTLS10')],
    ['body limit removed', staticText, dynamicText.replace('maxRequestBodyBytes: 1048576', 'maxRequestBodyBytes: 0')],
    ['editor authentication removed', staticText, dynamicText.replace('middlewares: [editor-auth, security-headers, editor-rate-limit]', 'middlewares: [security-headers, editor-rate-limit]')],
    ['authorization header forwarded', staticText, dynamicText.replace('removeHeader: true', 'removeHeader: false')],
    ['webhook rate control removed', staticText, dynamicText.replace('middlewares: [security-headers, webhook-body-limit, webhook-rate-limit]', 'middlewares: [security-headers, webhook-body-limit]')],
    ['editor rate control removed', staticText, dynamicText.replace('middlewares: [editor-auth, security-headers, editor-rate-limit]', 'middlewares: [editor-auth, security-headers]')],
    ['arbitrary webhook prefix', staticText, dynamicText.replace('Path(`/webhook/clientops/leads`)', 'PathPrefix(`/webhook/`)')],
  ];
  let rejected = 0;
  for (const [, st, dy] of mutants) {
    try { assertStaticHardening(st); assertDynamicHardening(dy); }
    catch { rejected += 1; }
  }
  assert.equal(rejected, mutants.length, 'edge hardening mutation checker failed to reject every mutant');
  return { rejected, total: mutants.length };
}

try {
  for (const path of ['clientops', 'scripts', 'policy-engine']) await cp(join(root, path), join(sandbox, path), { recursive: true });
  const setup = run(['setup', 'edge-owner@example.com', 'UTC']);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);

  const envLocal = await readFile(join(sandbox, '.env'), 'utf8');
  for (const line of [
    'CLIENTOPS_EDGE_MODE=local',
    'CLIENTOPS_PUBLIC_HOST=localhost',
    'CLIENTOPS_PUBLIC_ORIGIN=https://localhost:8443',
    'CLIENTOPS_EDGE_BIND_HTTP=127.0.0.1:8080',
    'CLIENTOPS_EDGE_BIND_HTTPS=127.0.0.1:8443',
  ]) assert(envLocal.includes(`${line}\n`), `local env missing ${line}`);
  assert.match(envLocal, /^CLIENTOPS_EDGE_PASSWORD=[0-9a-f]{64}$/m);
  assert.equal((await stat(join(sandbox, '.env'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(sandbox, 'runtime'))).mode & 0o777, 0o700);

  const dynamicLocal1 = await readFile(join(sandbox, 'runtime', 'edge-dynamic.yml'), 'utf8');
  const staticLocal1 = await readFile(join(sandbox, 'runtime', 'traefik.yml'), 'utf8');
  const usersLocal = await readFile(join(sandbox, 'runtime', 'edge-users'), 'utf8');
  assertLocalDynamic(dynamicLocal1);
  assert.doesNotMatch(staticLocal1, /certificatesResolvers:/);
  assert.match(staticLocal1, /permanent: true/);
  assert.match(staticLocal1, /strictTLSOptions: true/);
  assert.equal((staticLocal1.match(/aliasHeadersStrategy: reject/g) ?? []).length, 2);
  assert.equal((staticLocal1.match(/sanitizePath: true/g) ?? []).length, 2);
  assert.equal((staticLocal1.match(/maxHeaderBytes: 65536/g) ?? []).length, 2);
  assert.doesNotMatch(staticLocal1, /forwardedHeaders:\n[\s\S]*?insecure: true/);
  assertStaticHardening(staticLocal1);
  assertDynamicHardening(dynamicLocal1);
  const edgeMutations = rejectMutants(staticLocal1, dynamicLocal1);
  assert.match(usersLocal, /^clientops:\{SHA\}[A-Za-z0-9+/=]+\n$/);
  assert.doesNotMatch(usersLocal, /[0-9a-f]{64}/, 'plaintext generated edge password leaked to users file');
  assert.equal((await stat(join(sandbox, 'runtime', 'edge-users'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(sandbox, 'runtime', 'traefik.yml'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(sandbox, 'runtime', 'edge-dynamic.yml'))).mode & 0o777, 0o644);

  const render2 = run(['render-edge']);
  assert.equal(render2.status, 0, render2.stderr || render2.stdout);
  const dynamicLocal2 = await readFile(join(sandbox, 'runtime', 'edge-dynamic.yml'), 'utf8');
  const staticLocal2 = await readFile(join(sandbox, 'runtime', 'traefik.yml'), 'utf8');
  assert.equal(dynamicLocal2, dynamicLocal1, 'local dynamic edge rendering is not byte deterministic');
  assert.equal(staticLocal2, staticLocal1, 'local static edge rendering is not byte deterministic');

  for (const [host, email] of [
    ['127.0.0.1', 'ops@example.com'],
    ['localhost', 'ops@example.com'],
    ['Relay.EXAMPLE.com', 'ops@example.com'],
    ['relay.example.com', 'not-an-email'],
  ]) {
    const bad = run(['set-public', host, email]);
    assert.notEqual(bad.status, 0, `public mode accepted invalid host/email: ${host} ${email}`);
  }

  const publicRun = run(['set-public', 'relay.example.com', 'ops@example.com']);
  assert.equal(publicRun.status, 0, publicRun.stderr || publicRun.stdout);
  const envPublic = await readFile(join(sandbox, '.env'), 'utf8');
  for (const line of [
    'CLIENTOPS_EDGE_MODE=public',
    'CLIENTOPS_PUBLIC_HOST=relay.example.com',
    'CLIENTOPS_PUBLIC_ORIGIN=https://relay.example.com',
    'CLIENTOPS_ACME_EMAIL=ops@example.com',
    'CLIENTOPS_EDGE_BIND_HTTP=0.0.0.0:80',
    'CLIENTOPS_EDGE_BIND_HTTPS=0.0.0.0:443',
  ]) assert(envPublic.includes(`${line}\n`), `public env missing ${line}`);
  const dynamicPublic = await readFile(join(sandbox, 'runtime', 'edge-dynamic.yml'), 'utf8');
  const staticPublic = await readFile(join(sandbox, 'runtime', 'traefik.yml'), 'utf8');
  assert.match(dynamicPublic, /Host\(`relay\.example\.com`\)/);
  assert.match(dynamicPublic, /certResolver: letsencrypt/);
  assert.match(dynamicPublic, /stsSeconds: 31536000/);
  assert.match(staticPublic, /certificatesResolvers:/);
  assert.match(staticPublic, /httpChallenge:/);
  assert.match(staticPublic, /entryPoint: web/);

  const reverse = run(['set-local']);
  assert.equal(reverse.status, 0, reverse.stderr || reverse.stdout);
  const dynamicReversed = await readFile(join(sandbox, 'runtime', 'edge-dynamic.yml'), 'utf8');
  const staticReversed = await readFile(join(sandbox, 'runtime', 'traefik.yml'), 'utf8');
  assert.equal(dynamicReversed, dynamicLocal1, 'public -> local reverse transform did not restore byte-identical dynamic config');
  assert.equal(staticReversed, staticLocal1, 'public -> local reverse transform did not restore byte-identical static config');

  const compose = await readFile(join(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /image: traefik:3\.7\.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259/);
  assert.match(compose, /N8N_PROTOCOL: https/);
  assert.match(compose, /N8N_SECURE_COOKIE: "true"/);
  assert.match(compose, /N8N_PROXY_HOPS: "1"/);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:5680'\)/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:5681/);
  assert.match(compose, /N8N_EDITOR_BASE_URL: \$\{CLIENTOPS_PUBLIC_ORIGIN/);
  assert.match(compose, /N8N_WEBHOOK_URL: \$\{CLIENTOPS_PUBLIC_ORIGIN/);
  const n8nBlock = compose.match(/\n  n8n:\n([\s\S]*?)\n  task-runner:/)?.[1] ?? '';
  assert(n8nBlock, 'n8n service block not found');
  assert.doesNotMatch(n8nBlock, /\n\s+ports:/, 'n8n must not publish a host port');
  const postgresBlock = compose.match(/\n  postgres:\n([\s\S]*?)\n  database-migrate:/)?.[1] ?? '';
  assert.doesNotMatch(postgresBlock, /\n\s+ports:/, 'PostgreSQL must not publish a host port');
  assert.match(compose, /127\.0\.0\.1:8025:8025/);
  assert.match(compose, /127\.0\.0\.1:8081:80/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(compose, /data:\n    internal: true/);
  assert.match(compose, /automation:\n    internal: true/);

  process.stdout.write(JSON.stringify({
    status: 'PASS',
    contract: 'edge-security',
    localLoopbackHttpsConfig: true,
    publicAcmeConfigRendered: true,
    livePublicCertificateIssuance: 'NOT_RUN_REQUIRES_PUBLIC_DNS_AND_PORTS_80_443',
    n8nDirectHostPort: false,
    postgresHostPort: false,
    mailpitLoopbackOnly: true,
    ntfyLoopbackOnly: true,
    editorBasicAuth: true,
    publicWebhookPaths: ['/webhook/clientops/leads', '/webhook/clientops/leads/contacted'],
    arbitraryWebhookPrefixExposed: false,
    requestBodyLimitBytes: 1048576,
    routeRateLimits: true,
    secureCookies: true,
    proxyHops: 1,
    deterministicRenderSha256: sha(dynamicLocal1 + staticLocal1),
    forwardReverseByteIdentity: true,
    dockerSocketMounted: false,
    aliasHeaderSpoofingRejected: true,
    pathSanitization: true,
    maxHeaderBytes: 65536,
    minimumTlsVersion: 'TLS1.2',
    strictTlsOptions: true,
    adversarialEdgeMutantsRejected: `${edgeMutations.rejected}/${edgeMutations.total}`,
  }, null, 2) + '\n');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

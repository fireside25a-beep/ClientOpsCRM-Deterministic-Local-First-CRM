import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const excludedPrefixes = ['node_modules/', 'policy-engine/build/', 'runtime/', 'artifacts/runtime/', 'backups/'];
const binaryExtensions = new Set(['.png', '.gif', '.jpg', '.jpeg', '.webp', '.pdf', '.zip', '.gz', '.ico']);
const forbiddenBasename = /(?:^|[._-])(mock|stub|placeholder|temp|tmp)(?:[._-]|$)/i;
const absoluteLeak = new RegExp([['', 'mnt', 'data', ''].join('/'), ['', 'home', 'oai', ''].join('/')].join('|'));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const r = relative(root, p).replaceAll('\\', '/');
    if (excludedPrefixes.some((prefix) => r === prefix.slice(0, -1) || r.startsWith(prefix))) continue;
    if (e.isSymbolicLink()) out.push(p);
    else if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out.sort();
}

function assertDeploymentInvariants(text) {
  assert.match(text, /N8N_PROTOCOL: https/);
  assert.match(text, /N8N_SECURE_COOKIE: "true"/);
  assert.match(text, /N8N_PROXY_HOPS: "1"/);
  assert.match(text, /image: traefik:3\.7\.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259/);
  assert.match(text, /N8N_EDITOR_BASE_URL: \$\{CLIENTOPS_PUBLIC_ORIGIN/);
  assert.match(text, /N8N_WEBHOOK_URL: \$\{CLIENTOPS_PUBLIC_ORIGIN/);
  assert.doesNotMatch(text, /\n\s+WEBHOOK_URL:/);
  assert.doesNotMatch(text.match(/\n  n8n:\n([\s\S]*?)\n  task-runner:/)?.[1] ?? '', /\n\s+ports:/);
  assert.doesNotMatch(text.match(/\n  postgres:\n([\s\S]*?)\n  database-migrate:/)?.[1] ?? '', /\n\s+ports:/);
  assert.doesNotMatch(text, /docker\.sock/);
  assert.match(text, /data:\n    internal: true/);
  assert.match(text, /automation:\n    internal: true/);
}

const files = await walk(root);
assert(files.length > 50, 'release inventory unexpectedly small');
const empty = [];
const forbiddenNames = [];
const leakedPaths = [];
const symlinks = [];
const byteDigests = [];
for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const st = await lstat(file);
  if (st.isSymbolicLink()) { symlinks.push(rel); continue; }
  const bytes = await readFile(file);
  if (bytes.length === 0) empty.push(rel);
  if (forbiddenBasename.test(rel.split('/').at(-1))) forbiddenNames.push(rel);
  const reversedTwice = Buffer.from(Buffer.from(bytes).reverse()).reverse();
  assert(bytes.equals(reversedTwice), `reverse-byte involution failed: ${rel}`);
  byteDigests.push(`${createHash('sha256').update(bytes).digest('hex')}  ${rel}`);
  if (!binaryExtensions.has(extname(rel).toLowerCase())) {
    const text = bytes.toString('utf8');
    if (absoluteLeak.test(text)) leakedPaths.push(rel);
  }
}
assert.deepEqual(empty, [], `zero-byte regular files: ${empty.join(', ')}`);
assert.deepEqual(forbiddenNames, [], `forbidden mock/stub/temp/placeholder filenames: ${forbiddenNames.join(', ')}`);
assert.deepEqual(leakedPaths, [], `private build path leaked into release: ${leakedPaths.join(', ')}`);
assert.deepEqual(symlinks, [], `release must not depend on symlinks: ${symlinks.join(', ')}`);

const compose = await readFile(join(root, 'compose.yaml'), 'utf8');
assertDeploymentInvariants(compose);
const edgeConfigurator = await readFile(join(root, 'scripts', 'configure-edge.mjs'), 'utf8');
for (const hardening of ['strictTLSOptions: true', 'aliasHeadersStrategy: reject', 'sanitizePath: true', 'maxHeaderBytes: 65536', 'minVersion: VersionTLS12', 'maxRequestBodyBytes: 1048576']) {
  assert(edgeConfigurator.includes(hardening), `edge hardening missing: ${hardening}`);
}
assert(!edgeConfigurator.includes('PathPrefix(`\/webhook\/'), 'arbitrary webhook prefix exposure forbidden');
const mutants = [
  compose.replace('N8N_SECURE_COOKIE: "true"', 'N8N_SECURE_COOKIE: "false"'),
  compose.replace('N8N_PROXY_HOPS: "1"', 'N8N_PROXY_HOPS: "0"'),
  compose.replace('image: traefik:3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259', 'image: traefik:latest'),
  compose.replace('    networks:\n      - data\n      - automation\n      - edge', '    ports:\n      - "5678:5678"\n    networks:\n      - data\n      - automation\n      - edge'),
  compose.replace('    volumes:\n      - postgres_data:/var/lib/postgresql/data', '    ports:\n      - "5432:5432"\n    volumes:\n      - postgres_data:/var/lib/postgresql/data'),
  compose.replace('data:\n    internal: true', 'data:\n    internal: false'),
  compose + '\n# /var/run/docker.sock\n',
];
let rejected = 0;
for (const mutant of mutants) {
  try { assertDeploymentInvariants(mutant); } catch { rejected += 1; }
}
assert.equal(rejected, mutants.length, 'security mutation checker failed to reject every adversarial deployment mutant');

const inventoryDigest = createHash('sha256').update(byteDigests.join('\n') + '\n').digest('hex');
process.stdout.write(JSON.stringify({
  status: 'PASS',
  contract: 'release-audit',
  auditedRegularFiles: files.length,
  zeroByteFiles: 0,
  forbiddenArtifactNames: 0,
  privatePathLeaks: 0,
  symlinks: 0,
  reverseByteChecks: files.length,
  adversarialDeploymentMutantsRejected: `${rejected}/${mutants.length}`,
  inventoryDigestSha256: inventoryDigest,
}, null, 2) + '\n');

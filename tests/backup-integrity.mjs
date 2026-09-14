import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(root, 'scripts', 'bootstrap-n8n-state.mjs');
const directory = await mkdtemp(join(tmpdir(), 'clientops-backup-integrity-'));
const manifest = join(directory, 'SHA256SUMS.json');

function run(...args) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
}

try {
  await writeFile(join(directory, 'workflows.json'), '[{"id":"workflow"}]\n', { mode: 0o600 });
  await writeFile(join(directory, 'credentials.encrypted.json'), '[{"id":"credential","data":"encrypted"}]\n', { mode: 0o600 });
  await writeFile(join(directory, 'bootstrap-plan.json'), '{"ready":false}\n', { mode: 0o600 });

  let result = run('write-backup-manifest', directory, manifest);
  assert.equal(result.status, 0, result.stderr);
  result = run('verify-backup-manifest', directory, manifest);
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.algorithm, 'sha256');
  assert.deepEqual(Object.keys(parsed.files).sort(), [
    'bootstrap-plan.json',
    'credentials.encrypted.json',
    'workflows.json',
  ]);
  for (const record of Object.values(parsed.files)) {
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0);
  }

  await writeFile(join(directory, 'workflows.json'), '[{"id":"tampered"}]\n', { mode: 0o600 });
  result = run('verify-backup-manifest', directory, manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed for workflows\.json/);

  process.stdout.write('Backup integrity: copied encrypted state is checksum-verified before mutation.\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}

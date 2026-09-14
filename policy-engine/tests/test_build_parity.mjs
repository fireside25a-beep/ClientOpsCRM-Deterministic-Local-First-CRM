import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [release, debug, asan, ubsan, config] = process.argv.slice(2);
assert.ok(release && debug && asan && ubsan && config, 'expected four binaries and policy config');

const base = {
  leadId: 'build-parity-0001',
  channel: 'website',
  name: 'Build Parity',
  city: '',
  phone: '+35722000000',
  email: 'parity@example.test',
  source: 'native-build-gate',
  message: 'Urgent commercial request with a deterministic native result.',
  consent: true,
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clientops-build-parity-'));
const baseConfig = JSON.parse(await readFile(config, 'utf8'));
const allowlistConfig = join(temporaryDirectory, 'allowlist.json');
const invalidConfig = join(temporaryDirectory, 'invalid.json');
await writeFile(allowlistConfig, JSON.stringify({
  ...baseConfig,
  location_mode: 'allowlist',
  allowed_locations: ['Allowed Region'],
  unknown_location_serviceable: false,
}));
await writeFile(invalidConfig, JSON.stringify({ ...baseConfig, obsolete_setting: true }));

const cases = [
  ['urgent', base, config],
  ['sales', { ...base, leadId: 'build-parity-0002', message: 'I would like pricing and a consultation for your services.' }, config],
  ['partnership', { ...base, leadId: 'build-parity-0003', message: 'We would like to discuss a referral partnership with your team.' }, config],
  ['fallback', { ...base, leadId: 'build-parity-0004', message: 'Please send more information about what your organization provides.' }, config],
  ['low', { ...base, leadId: 'build-parity-0005', message: 'This is not urgent; we need support whenever convenient.' }, config],
  ['spam', { ...base, leadId: 'build-parity-0006', message: 'Buy backlinks through our guest post placement network.' }, config],
  ['excluded', { ...base, leadId: 'build-parity-0007', message: 'This is a press inquiry for your communications team.' }, config],
  ['insufficient', { ...base, leadId: 'build-parity-0008', message: 'Please call.' }, config],
  ['ambiguous', { ...base, leadId: 'build-parity-0009', message: 'We need support for an issue and would also like pricing.' }, config],
  ['invalid-consent', { ...base, leadId: 'build-parity-0010', consent: false }, config],
  ['unknown-field', { ...base, leadId: 'build-parity-0011', injected: 'not allowed' }, config],
  ['location-review', { ...base, leadId: 'build-parity-0012', city: 'Outside Region', message: 'I would like pricing and a consultation for your services.' }, allowlistConfig],
  ['invalid-config', { ...base, leadId: 'build-parity-0013' }, invalidConfig],
];

const binaries = [
  ['Release', release, {}],
  ['Debug', debug, {}],
  ['ASan', asan, { ASAN_OPTIONS: 'detect_leaks=0:halt_on_error=1' }],
  ['UBSan', ubsan, { UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' }],
];

const combined = createHash('sha256');
try {
  for (const [caseName, request, caseConfig] of cases) {
    const input = `${JSON.stringify(request)}\n`;
    const outputs = binaries.map(([name, binary, extraEnv]) => {
      const result = spawnSync(binary, ['--config', caseConfig], {
        encoding: 'utf8',
        input,
        env: { ...process.env, ...extraEnv },
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, `${name}/${caseName} failed to start: ${result.error?.message}`);
      assert.equal(result.signal, null, `${name}/${caseName} exited on signal ${result.signal}: ${result.stderr}`);
      assert.equal(result.stderr, '', `${name}/${caseName} wrote to stderr`);
      JSON.parse(result.stdout);
      return { status: result.status, stdout: result.stdout };
    });

    for (const [index, output] of outputs.entries()) {
      assert.deepEqual(output, outputs[0], `${binaries[index][0]} differs from Release for ${caseName}`);
    }
    combined.update(caseName).update('\0').update(String(outputs[0].status)).update('\0').update(outputs[0].stdout).update('\0');
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write(`Native build parity: ${cases.length} cases across Release/Debug/ASan/UBSan = ${combined.digest('hex')}\n`);

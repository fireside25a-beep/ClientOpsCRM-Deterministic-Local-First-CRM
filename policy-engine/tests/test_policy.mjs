import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'build/policy_cli');
const config = resolve(process.argv[3] ?? 'config/policy.json');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clientops-policy-'));
process.on('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));

function evaluate(input, configPath = config) {
  const run = spawnSync(binary, ['--config', configPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 2_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`invalid JSON from policy process: ${run.stdout}\n${run.stderr}`, { cause: error });
  }
  return { ...run, parsed };
}

function writeConfig(name, transform) {
  const baseConfig = JSON.parse(readFileSync(config, 'utf8'));
  const destination = join(temporaryDirectory, name);
  writeFileSync(destination, JSON.stringify(transform(baseConfig)));
  return destination;
}

const base = {
  leadId: 'inquiry-001',
  channel: 'website',
  name: 'Jordan Lee',
  city: '',
  phone: '',
  email: 'JORDAN@EXAMPLE.TEST',
  source: 'portfolio-demo',
  message: 'Our account has a critical issue and we need support today.',
  consent: true,
};

const urgent = evaluate(base);
assert.equal(urgent.status, 0);
assert.equal(urgent.parsed.ok, true);
assert.equal(urgent.parsed.policyVersion, 'clientops-triage-v1');
assert.equal(urgent.parsed.lead.email, 'jordan@example.test');
assert.equal(urgent.parsed.decision.route, 'ROUTE_URGENT');
assert.equal(urgent.parsed.decision.category, 'support');
assert.equal(urgent.parsed.decision.serviceable, true);
assert.equal(urgent.parsed.decision.urgency, 'high');
assert(Number.isInteger(urgent.parsed.decision.score));
assert(urgent.parsed.decision.score >= 0 && urgent.parsed.decision.score <= 100);
assert.deepEqual(Object.keys(urgent.parsed.decision).sort(), [
  'category', 'draftReply', 'fit', 'fitReason', 'nextStep', 'route', 'score',
  'serviceable', 'summary', 'urgency',
]);

const withLocation = evaluate({ ...base, leadId: 'inquiry-001b', city: 'Example Region' });
assert.deepEqual(withLocation.parsed.decision, urgent.parsed.decision);

const sales = evaluate({
  ...base,
  leadId: 'inquiry-002',
  phone: '+357 22 555 0100',
  message: 'I would like pricing and a consultation for your services.',
});
assert.equal(sales.status, 0);
assert.equal(sales.parsed.lead.phone, '+357225550100');
assert.equal(sales.parsed.decision.category, 'sales');
assert.equal(sales.parsed.decision.route, 'ROUTE_STANDARD');

const partnership = evaluate({
  ...base,
  leadId: 'inquiry-003',
  message: 'We would like to discuss a referral partnership with your team.',
});
assert.equal(partnership.status, 0);
assert.equal(partnership.parsed.decision.category, 'partnership');
assert.equal(partnership.parsed.decision.route, 'ROUTE_SPECIALIST');

const fallback = evaluate({
  ...base,
  leadId: 'inquiry-004',
  phone: '22 555 0100',
  message: 'Please send more information about what your organization provides.',
});
assert.equal(fallback.status, 0);
assert.equal(fallback.parsed.lead.phone, '225550100');
assert.equal(fallback.parsed.decision.category, 'general');
assert.equal(fallback.parsed.decision.route, 'ROUTE_STANDARD');

const lowPriority = evaluate({
  ...base,
  leadId: 'inquiry-005',
  message: 'This is not urgent; we need support whenever convenient.',
});
assert.equal(lowPriority.status, 0);
assert.equal(lowPriority.parsed.decision.urgency, 'low');
assert.equal(lowPriority.parsed.decision.route, 'ROUTE_SPECIALIST');

const spam = evaluate({
  ...base,
  leadId: 'inquiry-006',
  message: 'Buy backlinks through our guest post placement network.',
});
assert.equal(spam.status, 0);
assert.equal(spam.parsed.decision.route, 'ROUTE_SPAM');
assert.equal(spam.parsed.decision.draftReply, '');

const excluded = evaluate({
  ...base,
  leadId: 'inquiry-007',
  message: 'This is a press inquiry for your communications team.',
});
assert.equal(excluded.status, 0);
assert.equal(excluded.parsed.decision.route, 'ROUTE_UNSUPPORTED');

const noFallbackConfig = writeConfig('no-fallback.json', (value) => ({
  ...value,
  fallback_category: '',
  out_of_scope_keywords: [],
}));
const unsupported = evaluate({
  ...base,
  leadId: 'inquiry-008',
  message: 'Please send more information about what your organization provides.',
}, noFallbackConfig);
assert.equal(unsupported.status, 0);
assert.equal(unsupported.parsed.decision.route, 'ROUTE_UNSUPPORTED');

const insufficient = evaluate({ ...base, leadId: 'inquiry-009', message: 'Please call.' });
assert.equal(insufficient.status, 0);
assert.equal(insufficient.parsed.decision.route, 'ROUTE_INSUFFICIENT_INFORMATION');

const ambiguous = evaluate({
  ...base,
  leadId: 'inquiry-010',
  message: 'We need support for an issue and would also like pricing.',
});
assert.equal(ambiguous.status, 0);
assert.equal(ambiguous.parsed.decision.category, 'ambiguous');
assert.equal(ambiguous.parsed.decision.route, 'ROUTE_MANUAL_REVIEW');

const allowlistConfig = writeConfig('location-allowlist.json', (value) => ({
  ...value,
  location_mode: 'allowlist',
  allowed_locations: ['Allowed Region'],
  unknown_location_serviceable: false,
}));
const locationReview = evaluate({
  ...base,
  leadId: 'inquiry-011',
  city: 'Outside Region',
  message: 'I would like pricing and a consultation for your services.',
}, allowlistConfig);
assert.equal(locationReview.status, 0);
assert.equal(locationReview.parsed.decision.serviceable, false);
assert.equal(locationReview.parsed.decision.route, 'ROUTE_LOCATION_REVIEW');

const invalid = evaluate({ ...base, consent: false });
assert.equal(invalid.status, 2);
assert.equal(invalid.parsed.error.code, 'validation_error');

const unknown = evaluate({ ...base, injected: 'not allowed' });
assert.equal(unknown.status, 2);
assert.match(unknown.parsed.error.message, /unknown field/);

const invalidConfig = writeConfig('unknown-key.json', (value) => ({ ...value, obsolete_setting: true }));
const rejectedConfig = evaluate(base, invalidConfig);
assert.equal(rejectedConfig.status, 78);
assert.equal(rejectedConfig.parsed.error.code, 'config_error');

const firstBytes = Buffer.from(urgent.stdout);
const firstHash = createHash('sha256').update(firstBytes).digest('hex');
for (let i = 0; i < 100; i += 1) {
  const replay = evaluate(base);
  assert.equal(replay.status, 0);
  const hash = createHash('sha256').update(replay.stdout).digest('hex');
  assert.equal(hash, firstHash, `determinism failure on repetition ${i + 1}`);
}

process.stdout.write(JSON.stringify({
  status: 'PASS',
  cases: 13,
  deterministicRepetitions: 100,
  referenceSha256: firstHash,
  policyVersion: urgent.parsed.policyVersion,
}) + '\n');

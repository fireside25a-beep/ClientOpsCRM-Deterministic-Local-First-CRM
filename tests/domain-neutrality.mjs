import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowedCompatibilityFiles = new Set([
  'database/migrations/002-universal-v1.1.sql',
  'tests/fixtures/core-v1/01-api-lead-intake.json',
  'tests/fixtures/core-v1/20-outbox-dispatcher.json',
  'tests/fixtures/core-v1/30-sla-monitor.json',
  'tests/fixtures/core-v1/40-daily-digest.json',
  'tests/fixtures/core-v1/50-mark-contacted.json',
  'tests/fixtures/core-v1/60-retention-maintenance.json',
  'tests/fixtures/core-v1/90-error-sink.json',
  'tests/upgrade.mjs',
  'tests/domain-neutrality.mjs',
]);
const ignoredDirectories = new Set(['node_modules', 'build', '.git']);
const textExtensions = new Set([
  '.c', '.h', '.js', '.json', '.md', '.mjs', '.sh', '.sql', '.svg', '.yaml', '.yml',
]);
const forbidden = [
  ['vertical-specific service', /\b(?:floor[- ]?coat(?:ing|ed)?|flooring|epoxy|polyaspartic|plancher)\b/iu],
  ['vertical-specific location', /\b(?:garage|basement|sous-sol|driveway|patio|warehouse)\b/iu],
  ['area measurement', /(?:\bsqft\b|\bsq\.?\s*ft\b|\bsquare\s+(?:feet|foot|meters?|metres?)\b|m²|pi²|\bpieds?\s+carr|\bmètres?\s+carr|\bmetres?\s+carr)/iu],
  ['legacy region', /\b(?:Vancouver|Surrey|Richmond|Burnaby|Coquitlam|White Rock|North Vancouver|Delta|Langley|Port Moody)\b/iu],
  ['legacy decision contract', /(?:service_area|in_area|inArea|min_per_sqft|max_per_sqft|STANDARD_RESIDENTIAL|ROUTE_COMMERCIAL|OUT_OF_AREA|dlp-core-15e5321|\/v1\/qualify)/u],
  ['hardcoded regional timezone', /Asia\/Nicosia/u],
];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolute));
    else if (textExtensions.has(extname(entry.name)) || entry.name === 'clientops') files.push(absolute);
  }
  return files;
}

const violations = [];
for (const file of await collect(root)) {
  const local = relative(root, file);
  if (allowedCompatibilityFiles.has(local)) continue;
  const contents = await readFile(file, 'utf8');
  for (const [label, expression] of forbidden) {
    const match = contents.match(expression);
    if (match) violations.push(`${local}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

const binary = join(root, 'policy-engine', 'build', 'policy_cli');
let binaryStrings = '';
try {
  binaryStrings = execFileSync('strings', [binary], { encoding: 'utf8' });
} catch (error) {
  assert.fail(`Unable to inspect compiled policy binary: ${error.message}`);
}
for (const [label, expression] of forbidden) {
  const match = binaryStrings.match(expression);
  if (match) violations.push(`policy-engine/build/policy_cli: ${label}: ${JSON.stringify(match[0])}`);
}

assert.deepEqual(violations, [], `domain-specific assumptions remain:\n${violations.join('\n')}`);

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  contract: 'domain-neutrality',
  scannedFiles: (await collect(root)).length - allowedCompatibilityFiles.size,
  compatibilityExceptions: [...allowedCompatibilityFiles].sort(),
  compiledBinaryInspected: true,
}, null, 2)}\n`);

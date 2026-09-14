import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CLIENTOPS_POLICY_CONFIG
  ? resolve(process.cwd(), process.env.CLIENTOPS_POLICY_CONFIG)
  : join(root, 'policy-engine', 'config', 'policy.json');
const mode = process.argv[2];
const locations = process.argv.slice(3);

function requireCondition(condition, message) {
  if (!condition) {
    process.stderr.write(`Region configuration error: ${message}\n`);
    process.exit(2);
  }
}

requireCondition(['any', 'allowlist'].includes(mode), 'mode must be any or allowlist');
if (mode === 'any') {
  requireCondition(locations.length === 0, 'any mode does not accept location names');
} else {
  requireCondition(locations.length > 0, 'allowlist mode requires at least one location');
  requireCondition(locations.length <= 64, 'allowlist mode accepts at most 64 locations');
}
for (const location of locations) {
  requireCondition(location.length > 0 && Buffer.byteLength(location, 'utf8') <= 127,
    'each UTF-8 location must contain 1–127 bytes');
  requireCondition(!/[\u0000-\u001f\u007f]/u.test(location), 'locations cannot contain control characters');
}
requireCondition(new Set(locations.map((value) => value.toLocaleLowerCase('en-US'))).size === locations.length,
  'location names must be unique');

const config = JSON.parse(await readFile(configPath, 'utf8'));
config.location_mode = mode;
config.allowed_locations = mode === 'any' ? [] : locations;
config.unknown_location_serviceable = mode === 'any';

const temporaryPath = `${configPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
await rename(temporaryPath, configPath);

process.stdout.write(`${JSON.stringify({
  status: 'configured',
  locationMode: mode,
  allowedLocations: config.allowed_locations,
  unknownLocationServiceable: config.unknown_location_serviceable,
  rebuildRequired: true,
}, null, 2)}\n`);

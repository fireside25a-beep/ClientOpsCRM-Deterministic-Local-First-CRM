import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = join(dirname(fileURLToPath(import.meta.url)), '..');
const thirdParty = join(engine, 'third_party');
const source = JSON.parse(await readFile(join(thirdParty, 'cJSON.SOURCE.json'), 'utf8'));
const images = JSON.parse(await readFile(join(engine, 'CONTAINER_IMAGES.lock.json'), 'utf8'));

assert.equal(source.name, 'cJSON');
assert.equal(source.version, '1.7.19');
assert.equal(source.upstreamTag, 'v1.7.19');
assert.match(source.sourceArchiveSha256, /^[a-f0-9]{64}$/);

for (const [name, expected] of Object.entries(source.files)) {
  const contents = await readFile(join(thirdParty, name));
  const actual = createHash('sha256').update(contents).digest('hex');
  assert.equal(actual, expected, `${name} differs from the pinned upstream source`);
}

const header = await readFile(join(thirdParty, 'cJSON.h'), 'utf8');
assert.match(header, /#define CJSON_VERSION_MAJOR 1/);
assert.match(header, /#define CJSON_VERSION_MINOR 7/);
assert.match(header, /#define CJSON_VERSION_PATCH 19/);

const makefile = await readFile(join(engine, 'Makefile'), 'utf8');
assert.match(makefile, /third_party\/cJSON\.c/);
assert.doesNotMatch(makefile, /(?:^|\s)-lcjson(?:\s|$)/m);

const dockerfile = await readFile(join(engine, 'Dockerfile'), 'utf8');
assert.doesNotMatch(dockerfile, /libcjson(?:-dev|1)?/i);
assert.equal(images.formatVersion, 1);
for (const image of Object.values(images.images)) {
  assert.equal(image.digestKind, 'oci-image-index');
  assert.match(image.reference, /^[a-z0-9][a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/);
  assert.match(dockerfile, new RegExp(`FROM ${image.reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}
assert.doesNotMatch(dockerfile, /apt-get|apk add|dnf install/);

const companionDockerfile = await readFile(join(engine, '..', 'companion', 'Dockerfile'), 'utf8');
for (const image of Object.values(images.images)) {
  assert.match(companionDockerfile, new RegExp(`FROM ${image.reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}
assert.doesNotMatch(companionDockerfile, /apt-get|apk add|dnf install/);

const binary = join(engine, 'build', 'policy_cli');
const linked = spawnSync('ldd', [binary], { encoding: 'utf8' });
assert.equal(linked.status, 0, linked.stderr || linked.stdout);
assert.doesNotMatch(`${linked.stdout}\n${linked.stderr}`, /libcjson/i);

process.stdout.write('Supply chain: cJSON 1.7.19, OCI image indexes, and native linkage verified.\n');

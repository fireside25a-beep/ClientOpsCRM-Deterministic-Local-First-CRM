#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const NORMALIZATION = 'clientops-relay-workflow-semantics-v1';

const WORKFLOWS = [
  ['clr_errors_00001', '90-error-sink.json'],
  ['clr_intake_00001', '01-api-lead-intake.json'],
  ['clr_outbox_00001', '20-outbox-dispatcher.json'],
  ['clr_sla_mon_0001', '30-sla-monitor.json'],
  ['clr_digest_00001', '40-daily-digest.json'],
  ['clr_contact_0001', '50-mark-contacted.json'],
  ['clr_retention_001', '60-retention-maintenance.json'],
];

const CREDENTIAL_IDS = [
  'clientops-intake-api-key',
  'clientops-admin-api-key',
  'clientops-postgres',
  'clientops-smtp',
];

const BACKUP_FILES = [
  'bootstrap-plan.json',
  'credentials.encrypted.json',
  'workflows.json',
];

function fail(message) {
  process.stderr.write(`ClientOps Relay bootstrap: ${message}\n`);
  process.exit(1);
}

function readJson(path, label = basename(path)) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read valid JSON from ${label}: ${error.message}`);
  }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function semanticWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('a workflow is not a JSON object');
  }
  if (typeof workflow.id !== 'string' || !workflow.id) fail('a workflow has no fixed string ID');
  if (typeof workflow.name !== 'string' || !workflow.name) fail(`workflow ${workflow.id} has no name`);
  if (!Array.isArray(workflow.nodes)) fail(`workflow ${workflow.id} has no nodes array`);
  if (workflow.connections === null || typeof workflow.connections !== 'object' || Array.isArray(workflow.connections)) {
    fail(`workflow ${workflow.id} has no connections object`);
  }

  const nodeIds = new Set();
  const nodeNames = new Set();
  const nodes = workflow.nodes.map((node) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      fail(`workflow ${workflow.id} contains an invalid node`);
    }
    if (typeof node.id !== 'string' || !node.id) fail(`workflow ${workflow.id} contains a node without an ID`);
    if (typeof node.name !== 'string' || !node.name) fail(`workflow ${workflow.id} contains a node without a name`);
    if (nodeIds.has(node.id)) fail(`workflow ${workflow.id} contains duplicate node ID ${node.id}`);
    if (nodeNames.has(node.name)) fail(`workflow ${workflow.id} contains duplicate node name ${node.name}`);
    nodeIds.add(node.id);
    nodeNames.add(node.name);
    const semanticNode = { ...node };
    delete semanticNode.position;
    return semanticNode;
  }).sort((left, right) => left.id.localeCompare(right.id));

  const settings = { ...(workflow.settings ?? {}) };
  // n8n injects the instance timezone during export even when it was not part
  // of the imported workflow. It is deployment state, not workflow semantics.
  delete settings.timezone;

  return sorted({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? null,
    nodes,
    connections: workflow.connections,
    settings,
  });
}

function fingerprint(workflow) {
  return createHash('sha256').update(JSON.stringify(semanticWorkflow(workflow))).digest('hex');
}

function indexByFixedId(items, label) {
  if (!Array.isArray(items)) fail(`${label} must contain a JSON array`);
  const indexed = new Map();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`${label} contains a non-object item`);
    if (typeof item.id !== 'string' || !item.id) fail(`${label} contains an item without a string ID`);
    if (indexed.has(item.id)) fail(`${label} contains duplicate ID ${item.id}`);
    indexed.set(item.id, item);
  }
  return indexed;
}

function loadSources(sourceDirectory) {
  return new Map(WORKFLOWS.map(([expectedId, filename]) => {
    const path = resolve(sourceDirectory, filename);
    const workflow = readJson(path, filename);
    if (workflow.id !== expectedId) {
      fail(`${filename} must retain fixed ID ${expectedId}, found ${String(workflow.id)}`);
    }
    return [expectedId, { filename, workflow, fingerprint: fingerprint(workflow) }];
  }));
}

function loadLegacy(path) {
  const manifest = readJson(path, 'v1 semantic fingerprint fixture');
  if (manifest.formatVersion !== 1 || manifest.normalization !== NORMALIZATION) {
    fail('the v1 semantic fingerprint fixture has an unsupported format');
  }
  if (manifest.workflows === null || typeof manifest.workflows !== 'object' || Array.isArray(manifest.workflows)) {
    fail('the v1 semantic fingerprint fixture has no workflow map');
  }
  const expectedIds = new Set(WORKFLOWS.map(([id]) => id));
  for (const id of expectedIds) {
    if (!/^[a-f0-9]{64}$/.test(manifest.workflows[id]?.sha256 ?? '')) {
      fail(`the v1 semantic fingerprint fixture is missing ${id}`);
    }
  }
  for (const id of Object.keys(manifest.workflows)) {
    if (!expectedIds.has(id)) fail(`the v1 semantic fingerprint fixture contains unexpected ID ${id}`);
  }
  return manifest;
}

function isPublishedCurrent(workflow) {
  return workflow.active === true
    && typeof workflow.activeVersionId === 'string'
    && workflow.activeVersionId.length > 0
    && (workflow.versionId === undefined || workflow.versionId === workflow.activeVersionId);
}

function createPlan(exportPath, sourceDirectory, legacyPath) {
  const exported = indexByFixedId(readJson(exportPath, 'workflow export'), 'workflow export');
  const sources = loadSources(sourceDirectory);
  const legacy = loadLegacy(legacyPath);
  const workflows = [];

  for (const [id, filename] of WORKFLOWS) {
    const source = sources.get(id);
    const installed = exported.get(id);
    const currentFingerprint = source.fingerprint;
    const legacyFingerprint = legacy.workflows[id].sha256;
    const installedFingerprint = installed ? fingerprint(installed) : null;
    let status;
    if (!installed) status = 'missing';
    else if (installedFingerprint === currentFingerprint) status = 'current';
    else if (installedFingerprint === legacyFingerprint) status = 'stock-v1';
    else status = 'customized';

    workflows.push({
      id,
      filename,
      status,
      publishedCurrent: installed ? isPublishedCurrent(installed) : false,
      installedFingerprint,
      currentFingerprint,
      stockV1Fingerprint: legacyFingerprint,
    });
  }

  return {
    formatVersion: 1,
    normalization: NORMALIZATION,
    workflows,
    importIds: workflows.filter(({ status }) => status === 'missing' || status === 'stock-v1').map(({ id }) => id),
    publishIds: workflows
      .filter(({ status, publishedCurrent }) => status !== 'customized'
        && (status === 'missing' || status === 'stock-v1' || !publishedCurrent))
      .map(({ id }) => id),
    customizedIds: workflows.filter(({ status }) => status === 'customized').map(({ id }) => id),
    ready: workflows.every(({ status, publishedCurrent }) => status === 'current' && publishedCurrent),
  };
}

function readPlan(path) {
  const plan = readJson(path, 'bootstrap plan');
  if (plan.formatVersion !== 1 || plan.normalization !== NORMALIZATION || !Array.isArray(plan.workflows)) {
    fail('bootstrap plan has an unsupported format');
  }
  return plan;
}

function credentialIndex(path) {
  return indexByFixedId(readJson(path, 'credential export'), 'credential export');
}

function assertEncryptedCredentialExport(path) {
  const credentials = credentialIndex(path);
  for (const credential of credentials.values()) {
    if (typeof credential.data !== 'string' || credential.data.length === 0) {
      fail(`credential backup for ${credential.id} is not encrypted; refusing to continue`);
    }
  }
}

function credentialIdsReady(path) {
  const credentials = credentialIndex(path);
  return CREDENTIAL_IDS.every((id) => credentials.has(id));
}

function writeMissingCredentials(exportPath, renderedPath, outputPath) {
  const existing = credentialIndex(exportPath);
  const rendered = indexByFixedId(readJson(renderedPath, 'rendered credentials'), 'rendered credentials');
  for (const id of CREDENTIAL_IDS) {
    if (!rendered.has(id)) fail(`rendered credentials are missing fixed ID ${id}`);
  }
  for (const id of rendered.keys()) {
    if (!CREDENTIAL_IDS.includes(id)) fail(`rendered credentials contain unexpected ID ${id}`);
  }
  const missing = CREDENTIAL_IDS.filter((id) => !existing.has(id)).map((id) => rendered.get(id));
  writeFileSync(outputPath, `${JSON.stringify(missing, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  process.stdout.write(`${missing.length}\n`);
}

function verifyPreservedCredentials(beforePath, afterPath) {
  const before = credentialIndex(beforePath);
  const after = credentialIndex(afterPath);
  for (const [id, oldCredential] of before) {
    if (!after.has(id)) fail(`existing credential ${id} disappeared during bootstrap`);
    const newCredential = after.get(id);
    if (oldCredential.name !== newCredential.name
      || oldCredential.type !== newCredential.type
      || oldCredential.data !== newCredential.data) {
      fail(`existing credential ${id} changed during bootstrap`);
    }
  }
}

function digestFile(path) {
  const contents = readFileSync(path);
  return {
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function writeBackupManifest(directoryPath, outputPath) {
  const files = Object.fromEntries(BACKUP_FILES.map((name) => [
    name,
    digestFile(resolve(directoryPath, name)),
  ]));
  const manifest = {
    formatVersion: 1,
    algorithm: 'sha256',
    files,
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
}

function verifyBackupManifest(directoryPath, manifestPath) {
  const manifest = readJson(manifestPath, 'backup checksum manifest');
  if (manifest.formatVersion !== 1 || manifest.algorithm !== 'sha256'
    || manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    fail('backup checksum manifest has an unsupported format');
  }
  assertExactKeys(Object.keys(manifest.files), BACKUP_FILES, 'backup checksum manifest');
  for (const name of BACKUP_FILES) {
    const expected = manifest.files[name];
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
      || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
      || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '')) {
      fail(`backup checksum manifest contains an invalid record for ${name}`);
    }
    const actual = digestFile(resolve(directoryPath, name));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail(`backup checksum verification failed for ${name}`);
    }
  }
}

function assertExactKeys(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (actualSorted.length !== expectedSorted.length
    || actualSorted.some((value, index) => value !== expectedSorted[index])) {
    fail(`${label} must contain exactly: ${expectedSorted.join(', ')}`);
  }
}

function writeMarker(sourceDirectory, markerPath) {
  const sources = loadSources(sourceDirectory);
  const marker = {
    schemaVersion: 2,
    normalization: NORMALIZATION,
    workflows: Object.fromEntries(WORKFLOWS.map(([id]) => [id, sources.get(id).fingerprint])),
  };
  const temporaryPath = `${markerPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, markerPath);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'fingerprint': {
    if (args.length !== 1) fail('usage: fingerprint WORKFLOW_JSON');
    process.stdout.write(`${fingerprint(readJson(resolve(args[0])))}\n`);
    break;
  }
  case 'plan': {
    if (args.length !== 3) fail('usage: plan WORKFLOW_EXPORT SOURCE_DIRECTORY V1_FINGERPRINTS');
    process.stdout.write(`${JSON.stringify(createPlan(resolve(args[0]), resolve(args[1]), resolve(args[2])), null, 2)}\n`);
    break;
  }
  case 'assert-upgradable': {
    if (args.length !== 1) fail('usage: assert-upgradable PLAN');
    const plan = readPlan(resolve(args[0]));
    if (plan.customizedIds.length > 0) {
      const details = plan.workflows
        .filter(({ status }) => status === 'customized')
        .map(({ id, installedFingerprint }) => `${id} (${installedFingerprint})`)
        .join(', ');
      fail(`refusing to replace customized fixed-ID workflow(s): ${details}. Restore the stock v1 workflow or move the customized copy to a new ID before retrying`);
    }
    break;
  }
  case 'ready': {
    if (args.length !== 1) fail('usage: ready PLAN');
    if (!readPlan(resolve(args[0])).ready) process.exit(1);
    break;
  }
  case 'list-imports': {
    if (args.length !== 1) fail('usage: list-imports PLAN');
    process.stdout.write(`${readPlan(resolve(args[0])).importIds.join('\n')}\n`);
    break;
  }
  case 'list-replacements': {
    if (args.length !== 1) fail('usage: list-replacements PLAN');
    const replacementIds = readPlan(resolve(args[0])).workflows
      .filter(({ status }) => status === 'stock-v1')
      .map(({ id }) => id);
    process.stdout.write(`${replacementIds.join('\n')}\n`);
    break;
  }
  case 'list-publishes': {
    if (args.length !== 1) fail('usage: list-publishes PLAN');
    process.stdout.write(`${readPlan(resolve(args[0])).publishIds.join('\n')}\n`);
    break;
  }
  case 'verify-current': {
    if (args.length !== 3) fail('usage: verify-current WORKFLOW_EXPORT SOURCE_DIRECTORY V1_FINGERPRINTS');
    const plan = createPlan(resolve(args[0]), resolve(args[1]), resolve(args[2]));
    const invalid = plan.workflows.filter(({ status, publishedCurrent }) => status !== 'current' || !publishedCurrent);
    if (invalid.length > 0) {
      fail(`post-upgrade verification failed for ${invalid.map(({ id, status, publishedCurrent }) => `${id} (${status}, published=${publishedCurrent})`).join(', ')}`);
    }
    break;
  }
  case 'assert-encrypted-credentials': {
    if (args.length !== 1) fail('usage: assert-encrypted-credentials CREDENTIAL_EXPORT');
    assertEncryptedCredentialExport(resolve(args[0]));
    break;
  }
  case 'credentials-ready': {
    if (args.length !== 1) fail('usage: credentials-ready CREDENTIAL_EXPORT');
    if (!credentialIdsReady(resolve(args[0]))) process.exit(1);
    break;
  }
  case 'select-missing-credentials': {
    if (args.length !== 3) fail('usage: select-missing-credentials CREDENTIAL_EXPORT RENDERED_CREDENTIALS OUTPUT');
    writeMissingCredentials(resolve(args[0]), resolve(args[1]), resolve(args[2]));
    break;
  }
  case 'verify-preserved-credentials': {
    if (args.length !== 2) fail('usage: verify-preserved-credentials BEFORE_EXPORT AFTER_EXPORT');
    verifyPreservedCredentials(resolve(args[0]), resolve(args[1]));
    break;
  }
  case 'write-backup-manifest': {
    if (args.length !== 2) fail('usage: write-backup-manifest BACKUP_DIRECTORY OUTPUT');
    writeBackupManifest(resolve(args[0]), resolve(args[1]));
    break;
  }
  case 'verify-backup-manifest': {
    if (args.length !== 2) fail('usage: verify-backup-manifest BACKUP_DIRECTORY MANIFEST');
    verifyBackupManifest(resolve(args[0]), resolve(args[1]));
    break;
  }
  case 'write-marker': {
    if (args.length !== 2) fail('usage: write-marker SOURCE_DIRECTORY MARKER_PATH');
    writeMarker(resolve(args[0]), resolve(args[1]));
    break;
  }
  default:
    fail('expected one of: fingerprint, plan, assert-upgradable, ready, list-imports, list-replacements, list-publishes, verify-current, assert-encrypted-credentials, credentials-ready, select-missing-credentials, verify-preserved-credentials, write-backup-manifest, verify-backup-manifest, write-marker');
}

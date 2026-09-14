import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const CORE_IDS = [
  'clr_errors_00001', 'clr_intake_00001', 'clr_outbox_00001',
  'clr_sla_mon_0001', 'clr_digest_00001', 'clr_contact_0001',
  'clr_retention_001',
];
const OPTIONAL_IDS = ['clr_saas_adapt01', 'clr_cloud_intake1'];
const CREDENTIAL_IDS = [
  'clientops-intake-api-key', 'clientops-admin-api-key',
  'clientops-postgres', 'clientops-smtp',
];
const STOCK_REPLACEMENT_IDS = ['clr_intake_00001', 'clr_contact_0001'];

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function index(items) {
  assert(Array.isArray(items));
  return new Map(items.map((item) => [item.id, item]));
}

function assertCredentialsPreserved(beforeCredentials, afterCredentials) {
  for (const id of CREDENTIAL_IDS) {
    const before = beforeCredentials.get(id);
    const after = afterCredentials.get(id);
    assert(before, `missing pre-upgrade credential ${id}`);
    assert(after, `missing post-upgrade credential ${id}`);
    assert.equal(after.name, before.name, `${id} name changed`);
    assert.equal(after.type, before.type, `${id} type changed`);
    assert.equal(after.data, before.data, `${id} encrypted ciphertext changed`);
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === 'assert-fresh') {
  assert.equal(args.length, 2);
  const workflows = index(await json(args[0]));
  const credentials = index(await json(args[1]));
  for (const id of CORE_IDS) {
    const workflow = workflows.get(id);
    assert(workflow, `missing core workflow ${id}`);
    assert.equal(workflow.active, true, `${id} is not published`);
    assert.equal(workflow.activeVersionId, workflow.versionId, `${id} active version is stale`);
  }
  for (const id of OPTIONAL_IDS) {
    const workflow = workflows.get(id);
    assert(workflow, `missing optional workflow ${id}`);
    assert.equal(workflow.active, false, `${id} unexpectedly published`);
  }
  for (const id of CREDENTIAL_IDS) {
    const credential = credentials.get(id);
    assert(credential, `missing credential ${id}`);
    assert.equal(typeof credential.data, 'string');
    assert(credential.data.length > 0, `${id} is not encrypted in the export`);
  }
  process.stdout.write('Exact n8n: seven published core workflows plus two inactive imports verified.\n');
} else if (command === 'assert-stock-plan') {
  assert.equal(args.length, 1);
  const plan = await json(args[0]);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.customizedIds, []);
  assert.deepEqual([...plan.importIds].sort(), [...STOCK_REPLACEMENT_IDS].sort());
  assert.deepEqual([...plan.publishIds].sort(), [...STOCK_REPLACEMENT_IDS].sort());
  assert.equal(plan.workflows.length, CORE_IDS.length);
  for (const workflow of plan.workflows) {
    assert(CORE_IDS.includes(workflow.id), `unexpected stock workflow ${workflow.id}`);
    const expectedStatus = STOCK_REPLACEMENT_IDS.includes(workflow.id) ? 'stock-v1' : 'current';
    assert.equal(workflow.status, expectedStatus, `${workflow.id} has the wrong stock-fixture status`);
    assert.equal(workflow.publishedCurrent, true, `${workflow.id} was not published before upgrade`);
  }
  process.stdout.write('Exact n8n: seven frozen workflows classified; two changed stock-v1 workflows selected for replacement.\n');
} else if (command === 'assert-stock-preserved') {
  assert.equal(args.length, 4);
  const beforeWorkflows = index(await json(args[0]));
  const beforeCredentials = index(await json(args[1]));
  const afterWorkflows = index(await json(args[2]));
  const afterCredentials = index(await json(args[3]));
  for (const id of CORE_IDS) {
    const before = beforeWorkflows.get(id);
    const after = afterWorkflows.get(id);
    assert(before, `missing pre-preflight workflow ${id}`);
    assert(after, `missing post-preflight workflow ${id}`);
    for (const field of ['name', 'active', 'versionId', 'activeVersionId', 'nodes', 'connections', 'settings']) {
      assert.deepEqual(after[field], before[field], `${id} ${field} changed during preflight`);
    }
  }
  assertCredentialsPreserved(beforeCredentials, afterCredentials);
  process.stdout.write('Exact n8n: stock workflows and encrypted credentials unchanged by preflight.\n');
} else if (command === 'assert-stock-upgraded') {
  assert.equal(args.length, 3);
  const beforeCredentials = index(await json(args[0]));
  const afterCredentials = index(await json(args[1]));
  const workflows = index(await json(args[2]));
  assertCredentialsPreserved(beforeCredentials, afterCredentials);
  for (const id of CORE_IDS) {
    const workflow = workflows.get(id);
    assert(workflow, `missing upgraded workflow ${id}`);
    assert.equal(workflow.active, true, `${id} is not published after upgrade`);
    assert.equal(workflow.activeVersionId, workflow.versionId, `${id} active version is stale after upgrade`);
  }
  process.stdout.write('Exact n8n: stock v1 replaced with current published workflows; credential ciphertext preserved.\n');
} else if (command === 'write-customized') {
  assert.equal(args.length, 2);
  const workflows = index(await json(args[0]));
  const customized = structuredClone(workflows.get('clr_intake_00001'));
  assert(customized);
  customized.name = 'ClientOps Relay - API Intake [operator customization]';
  customized.active = false;
  await writeFile(args[1], `${JSON.stringify(customized, null, 2)}\n`);
} else if (command === 'assert-customized') {
  assert.equal(args.length, 1);
  const workflows = index(await json(args[0]));
  assert.equal(
    workflows.get('clr_intake_00001')?.name,
    'ClientOps Relay - API Intake [operator customization]',
  );
  process.stdout.write('Exact n8n: customized fixed-ID workflow remained untouched after refusal.\n');
} else {
  throw new Error('expected assert-fresh, assert-stock-plan, assert-stock-preserved, assert-stock-upgraded, write-customized, or assert-customized');
}

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDirectory = join(root, 'workflows', 'core');
const adapterDirectory = join(root, 'workflows', 'adapters');
const coreFiles = (await readdir(coreDirectory)).filter((name) => name.endsWith('.json')).sort();
const adapterFiles = (await readdir(adapterDirectory)).filter((name) => name.endsWith('.json')).sort();

assert.deepEqual(coreFiles, [
  '01-api-lead-intake.json',
  '20-outbox-dispatcher.json',
  '30-sla-monitor.json',
  '40-daily-digest.json',
  '50-mark-contacted.json',
  '60-retention-maintenance.json',
  '90-error-sink.json',
]);
assert.deepEqual(adapterFiles, ['google-sheets-slack-gmail.json']);

const expectedVersions = new Map([
  ['n8n-nodes-base.webhook', 2.1],
  ['n8n-nodes-base.respondToWebhook', 1.5],
  ['n8n-nodes-base.if', 2.3],
  ['n8n-nodes-base.switch', 3.4],
  ['n8n-nodes-base.set', 3.5],
  ['n8n-nodes-base.code', 2],
  ['n8n-nodes-base.httpRequest', 4.5],
  ['n8n-nodes-base.postgres', 2.7],
  ['n8n-nodes-base.emailSend', 2.1],
  ['n8n-nodes-base.errorTrigger', 1],
  ['n8n-nodes-base.scheduleTrigger', 1.3],
  ['n8n-nodes-base.manualTrigger', 1],
  ['n8n-nodes-base.executeWorkflowTrigger', 1.2],
  ['n8n-nodes-base.googleSheets', 4.7],
  ['n8n-nodes-base.slack', 2.5],
  ['n8n-nodes-base.gmail', 2.2],
]);

const triggers = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
]);
const webhookPaths = new Set();
const typesSeen = new Set();
const workflows = [];

for (const [directory, files, isCore] of [[coreDirectory, coreFiles, true], [adapterDirectory, adapterFiles, false]]) {
  for (const filename of files) {
    const text = await readFile(join(directory, filename), 'utf8');
    assert.doesNotMatch(text, /\b(?:TODO|FIXME|CHANGEME|YOUR_API_KEY)\b/i, filename);
    const data = JSON.parse(text);
    workflows.push(data);
    assert.equal(typeof data.id, 'string', filename);
    assert.equal(typeof data.name, 'string', filename);
    assert.equal(data.active, false, filename);
    assert(Array.isArray(data.nodes) && data.nodes.length > 0, filename);
    assert(data.connections && typeof data.connections === 'object', filename);
    assert.equal(data.settings.saveDataErrorExecution, 'none', `${filename}: error data persistence`);
    assert.equal(data.settings.saveDataSuccessExecution, 'none', `${filename}: success data persistence`);
    assert.equal(data.settings.saveManualExecutions, false, `${filename}: manual data persistence`);
    assert.equal(data.settings.saveExecutionProgress, false, `${filename}: progress data persistence`);
    assert.equal(Object.hasOwn(data.settings, 'timezone'), false, `${filename}: timezone must inherit GENERIC_TIMEZONE`);
    if (isCore && data.id !== 'clr_errors_00001') {
      assert.equal(data.settings.errorWorkflow, 'clr_errors_00001', filename);
    }

    const names = new Set();
    const ids = new Set();
    for (const node of data.nodes) {
      assert.equal(typeof node.id, 'string', `${filename}: node id`);
      assert.equal(typeof node.name, 'string', `${filename}: node name`);
      assert.equal(typeof node.type, 'string', `${filename}: ${node.name} type`);
      assert(Array.isArray(node.position) && node.position.length === 2, `${filename}: ${node.name} position`);
      assert(!names.has(node.name), `${filename}: duplicate node name ${node.name}`);
      assert(!ids.has(node.id), `${filename}: duplicate node id ${node.id}`);
      names.add(node.name);
      ids.add(node.id);
      typesSeen.add(node.type);
      assert.equal(node.typeVersion, expectedVersions.get(node.type), `${filename}: ${node.name} typeVersion`);
      if (node.type === 'n8n-nodes-base.webhook') {
        assert.equal(node.parameters.authentication, 'headerAuth', filename);
        assert.equal(node.parameters.responseMode, 'responseNode', filename);
        assert(!webhookPaths.has(node.parameters.path), `duplicate webhook path ${node.parameters.path}`);
        webhookPaths.add(node.parameters.path);
        const credential = node.credentials?.httpHeaderAuth;
        if (node.parameters.path === 'clientops/leads') {
          assert.equal(credential?.id, 'clientops-intake-api-key', filename);
        } else if (node.parameters.path === 'clientops/leads/contacted') {
          assert.equal(credential?.id, 'clientops-admin-api-key', filename);
        }
      }
      if (node.type === 'n8n-nodes-base.code') {
        assert.doesNotThrow(() => new Function(node.parameters.jsCode), `${filename}: ${node.name} code syntax`);
      }
    }

    const reachable = new Set(data.nodes.filter((node) => triggers.has(node.type)).map((node) => node.name));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [source, connection] of Object.entries(data.connections)) {
        assert(names.has(source), `${filename}: missing connection source ${source}`);
        assert(Array.isArray(connection.main), `${filename}: ${source} main outputs`);
        for (const output of connection.main) {
          assert(Array.isArray(output), `${filename}: ${source} output must be an array`);
          for (const link of output) {
            assert(names.has(link.node), `${filename}: missing target ${link.node}`);
            assert.equal(link.type, 'main', `${filename}: ${source} connection type`);
            if (reachable.has(source) && !reachable.has(link.node)) {
              reachable.add(link.node);
              changed = true;
            }
          }
        }
      }
    }
    for (const node of data.nodes) assert(reachable.has(node.name), `${filename}: unreachable node ${node.name}`);
  }
}

for (const requiredType of [
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  'n8n-nodes-base.postgres',
  'n8n-nodes-base.emailSend',
  'n8n-nodes-base.googleSheets',
  'n8n-nodes-base.slack',
  'n8n-nodes-base.gmail',
]) assert(typesSeen.has(requiredType), `required node type missing: ${requiredType}`);

const ids = workflows.map((item) => item.id);
assert.equal(ids.length, new Set(ids).size, 'workflow IDs must be unique');

const intake = workflows.find((item) => item.id === 'clr_intake_00001');
const policyRequest = intake.nodes.find((node) => node.name === 'Qualify Deterministically');
assert.equal(policyRequest.parameters.url, 'http://policy:8080/v2/qualify');

const adapter = workflows.find((item) => item.id === 'clr_saas_adapt01');
const sheetNode = adapter.nodes.find((node) => node.type === 'n8n-nodes-base.googleSheets');
assert.equal(sheetNode.parameters.operation, 'appendOrUpdate');
assert.deepEqual(sheetNode.parameters.columns.matchingColumns, ['ticketId']);
assert.equal(sheetNode.parameters.options.cellFormat, 'RAW');
assert.equal(sheetNode.parameters.options.handlingExtraData, 'error');
const sheetSafetyNode = adapter.nodes.find((node) => node.name === 'Prepare Safe Sheet Row');
assert(sheetSafetyNode.parameters.jsCode.includes('[=+\\-@]'), 'spreadsheet formula neutralization is required');
const executeSheetSafety = new Function('$input', sheetSafetyNode.parameters.jsCode);
const [safeSheetItem] = executeSheetSafety({
  all: () => [{ json: {
    ticketId: '00000000-0000-4000-8000-000000000000',
    name: '  =HYPERLINK("https://example.invalid")',
    email: '+formula@example.invalid',
    phone: '-1',
    city: '@city',
    category: '=support',
    score: 73,
    serviceable: true,
    urgency: 'high',
    priority: '-high',
    route: '@ROUTE_URGENT',
    summary: '=unsafe',
  } }],
});
for (const field of ['name', 'email', 'phone', 'city', 'category', 'priority', 'route', 'summary']) {
  assert(safeSheetItem.json[field].startsWith("'"), `spreadsheet field ${field} must be neutralized`);
}
assert.equal(safeSheetItem.json.score, 73);
assert.equal(safeSheetItem.json.serviceable, true);
const slackSafetyNode = adapter.nodes.find((node) => node.name === 'Build Safe Slack Message');
assert(slackSafetyNode, 'Slack message safety node is required');
for (const escaped of ['&amp;', '&lt;', '&gt;']) {
  assert(slackSafetyNode.parameters.jsCode.includes(escaped), `Slack message must emit ${escaped}`);
}
const executeSlackSafety = new Function('$', slackSafetyNode.parameters.jsCode);
const [safeSlackItem] = executeSlackSafety(() => ({ first: () => ({ json: {
  urgency: '<!channel>',
  category: '<support>',
  score: '80&more',
  name: 'A&B',
  summary: '<https://example.invalid|click>',
  ticketId: '00000000-0000-4000-8000-000000000000',
} }) }));
assert(safeSlackItem.json.slackText.includes('&lt;!channel&gt;'));
assert(safeSlackItem.json.slackText.includes('&lt;support&gt;'));
assert(safeSlackItem.json.slackText.includes('80&amp;more'));
assert(safeSlackItem.json.slackText.includes('A&amp;B'));
assert(safeSlackItem.json.slackText.includes('&lt;https://example.invalid|click&gt;'));
assert(!safeSlackItem.json.slackText.includes('<!channel>'));
const slackNode = adapter.nodes.find((node) => node.type === 'n8n-nodes-base.slack');
assert.equal(slackNode.parameters.text, '={{ $json.slackText }}');

process.stdout.write(JSON.stringify({
  status: 'PASS',
  contract: 'workflows',
  n8n: '2.37.10',
  core: coreFiles.length,
  optionalAdapters: adapterFiles.length,
  nodes: workflows.reduce((sum, item) => sum + item.nodes.length, 0),
  webhookPaths: [...webhookPaths].sort(),
}, null, 2) + '\n');

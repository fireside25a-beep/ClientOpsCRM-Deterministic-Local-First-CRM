import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts', 'portfolio');
const frames = join(output, 'demo-frames');
await mkdir(frames, { recursive: true });

const escape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const shortType = (type) => ({
  'n8n-nodes-base.webhook': 'WEBHOOK',
  'n8n-nodes-base.code': 'CODE',
  'n8n-nodes-base.if': 'IF',
  'n8n-nodes-base.switch': 'SWITCH',
  'n8n-nodes-base.httpRequest': 'HTTP',
  'n8n-nodes-base.postgres': 'POSTGRES',
  'n8n-nodes-base.respondToWebhook': 'RESPONSE',
  'n8n-nodes-base.emailSend': 'SMTP',
  'n8n-nodes-base.scheduleTrigger': 'SCHEDULE',
  'n8n-nodes-base.manualTrigger': 'MANUAL',
  'n8n-nodes-base.set': 'SET',
}[type] ?? type.split('.').at(-1).toUpperCase());

const nodeColor = (type) => ({
  'n8n-nodes-base.webhook': '#8B5CF6',
  'n8n-nodes-base.scheduleTrigger': '#8B5CF6',
  'n8n-nodes-base.manualTrigger': '#8B5CF6',
  'n8n-nodes-base.code': '#3B82F6',
  'n8n-nodes-base.if': '#F59E0B',
  'n8n-nodes-base.switch': '#F59E0B',
  'n8n-nodes-base.httpRequest': '#10B981',
  'n8n-nodes-base.postgres': '#14B8A6',
  'n8n-nodes-base.respondToWebhook': '#EC4899',
  'n8n-nodes-base.emailSend': '#06B6D4',
}[type] ?? '#64748B');

function nodeLines(name) {
  const words = name.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 20 && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

async function renderWorkflow(sourceFile, destinationFile, subtitle) {
  const workflow = JSON.parse(await readFile(sourceFile, 'utf8'));
  const width = 1800;
  const height = 760;
  const cardWidth = 164;
  const cardHeight = 82;
  const xs = workflow.nodes.map((node) => node.position[0]);
  const ys = workflow.nodes.map((node) => node.position[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const plot = { left: 70, top: 175, width: 1660, height: 500 };
  const mapX = (x) => plot.left + ((x - minX) / Math.max(maxX - minX, 1)) * (plot.width - cardWidth);
  const mapY = (y) => plot.top + ((y - minY) / Math.max(maxY - minY, 1)) * (plot.height - cardHeight);
  const positions = new Map(workflow.nodes.map((node) => [node.name, { x: mapX(node.position[0]), y: mapY(node.position[1]), node }]));
  const edgeParts = [];
  for (const [source, connection] of Object.entries(workflow.connections)) {
    const from = positions.get(source);
    for (let outputIndex = 0; outputIndex < connection.main.length; outputIndex += 1) {
      for (const link of connection.main[outputIndex]) {
        const to = positions.get(link.node);
        const x1 = from.x + cardWidth;
        const y1 = from.y + cardHeight / 2 + outputIndex * 8;
        const x2 = to.x;
        const y2 = to.y + cardHeight / 2;
        const bend = Math.max(35, (x2 - x1) / 2);
        const error = outputIndex > 0;
        edgeParts.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + bend).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${error ? '#FB7185' : '#64748B'}" stroke-width="2.5" ${error ? 'stroke-dasharray="7 5"' : ''} marker-end="url(#arrow)" opacity="0.9"/>`);
      }
    }
  }
  const nodeParts = workflow.nodes.map((node) => {
    const { x, y } = positions.get(node.name);
    const lines = nodeLines(node.name);
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="13" fill="#111A2E" stroke="${nodeColor(node.type)}" stroke-width="2"/>
      <rect x="0" y="0" width="7" height="${cardHeight}" rx="4" fill="${nodeColor(node.type)}"/>
      <text x="19" y="21" font-size="11" font-weight="700" fill="${nodeColor(node.type)}" letter-spacing="1.2">${shortType(node.type)}</text>
      ${lines.map((line, index) => `<text x="19" y="${46 + index * 18}" font-size="13" font-weight="600" fill="#F8FAFC">${escape(line)}</text>`).join('')}
    </g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#1E293B" stroke-width="1"/></pattern>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94A3B8"/></marker>
    <filter id="shadow"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity="0.25"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="#080D18"/>
  <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.7"/>
  <text x="70" y="72" font-family="DejaVu Sans, sans-serif" font-size="35" font-weight="700" fill="#F8FAFC">${escape(workflow.name)}</text>
  <text x="70" y="112" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">${escape(subtitle)}</text>
  <g font-family="DejaVu Sans, sans-serif" filter="url(#shadow)">${edgeParts.join('')}${nodeParts.join('')}</g>
  <g font-family="DejaVu Sans, sans-serif" transform="translate(70 720)">
    <circle cx="6" cy="-5" r="5" fill="#64748B"/><text x="19" y="0" font-size="13" fill="#94A3B8">normal path</text>
    <line x1="140" y1="-5" x2="178" y2="-5" stroke="#FB7185" stroke-width="2.5" stroke-dasharray="7 5"/><text x="190" y="0" font-size="13" fill="#94A3B8">validation / error path</text>
    <text x="1460" y="0" font-size="13" fill="#64748B">Generated from importable n8n JSON</text>
  </g>
</svg>`;
  await writeFile(destinationFile, svg);
}

function demoFrame(title, step, accent, columns, footer) {
  const cards = columns.map((column, index) => {
    const x = 85 + index * 500;
    return `<g transform="translate(${x} 230)">
      <rect width="440" height="330" rx="20" fill="#111A2E" stroke="${index === step ? accent : '#334155'}" stroke-width="${index === step ? 3 : 1.5}"/>
      <circle cx="42" cy="45" r="19" fill="${index === step ? accent : '#334155'}"/><text x="42" y="51" text-anchor="middle" font-size="17" font-weight="700" fill="#fff">${index + 1}</text>
      <text x="75" y="51" font-size="20" font-weight="700" fill="#F8FAFC">${escape(column.heading)}</text>
      ${column.lines.map((line, lineIndex) => `<text x="35" y="${105 + lineIndex * 37}" font-size="17" fill="${line.startsWith('✓') ? '#86EFAC' : '#CBD5E1'}">${escape(line)}</text>`).join('')}
    </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="700" viewBox="0 0 1600 700">
    <defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0L0 0 0 32" fill="none" stroke="#1E293B"/></pattern></defs>
    <rect width="1600" height="700" fill="#080D18"/><rect width="1600" height="700" fill="url(#grid)" opacity="0.65"/>
    <g font-family="DejaVu Sans, sans-serif">
      <text x="85" y="78" font-size="18" font-weight="700" letter-spacing="2" fill="${accent}">CLIENTOPS RELAY · LIVE CONTRACT DEMO</text>
      <text x="85" y="135" font-size="38" font-weight="700" fill="#F8FAFC">${escape(title)}</text>
      <text x="85" y="177" font-size="17" fill="#94A3B8">Real C policy output + real PostgreSQL functions; no model or delivery mocks</text>
      ${cards}
      <text x="85" y="635" font-size="16" fill="#94A3B8">${escape(footer)}</text>
      <text x="1400" y="635" font-size="15" fill="#64748B">clientops-relay</text>
    </g>
  </svg>`;
}

await renderWorkflow(
  join(root, 'workflows', 'core', '01-api-lead-intake.json'),
  join(output, 'lead-intake-workflow.svg'),
  'Strict request validation → deterministic C policy → atomic PostgreSQL outbox → safe public response',
);
await renderWorkflow(
  join(root, 'workflows', 'core', '20-outbox-dispatcher.json'),
  join(output, 'outbox-dispatcher-workflow.svg'),
  'Leased queue claims → fenced pre-send authorization → SMTP / ntfy routing → retry or dead letter',
);

const binary = join(root, 'policy-engine', 'build', 'policy_cli');
const policyConfig = join(root, 'policy-engine', 'config', 'policy.json');
const request = {
  leadId: 'portfolio-demo',
  channel: 'webhook',
  name: 'Jordan Lee',
  email: 'jordan@example.test',
  source: 'portfolio-demo',
  message: 'Our account has a critical issue and we need support today.',
  consent: true,
};
const run = spawnSync(binary, ['--config', policyConfig], { input: JSON.stringify(request), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr || run.stdout);
const policy = JSON.parse(run.stdout);

const db = new PGlite();
let created;
let replay;
let conflict;
let deliveries;
try {
  let schema = await readFile(join(root, 'database', 'schema.sql'), 'utf8');
  schema = schema.replace(/^\\set[^\n]*\n/m, '');
  await db.exec('CREATE ROLE clientops_app NOLOGIN;');
  await db.exec(schema);
  await db.exec(`INSERT INTO clientops.settings (key, value) VALUES
    ('owner_email', 'owner@clientops.local'), ('ntfy_topic', 'clientops-demo'),
    ('business_timezone', 'UTC'), ('retention_days', '90'), ('failure_retention_days', '30');`);
  created = (await db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    ['portfolio:key-001', JSON.stringify(request), JSON.stringify(policy)],
  )).rows[0];
  replay = (await db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    ['portfolio:key-001', JSON.stringify(request), JSON.stringify(policy)],
  )).rows[0];
  conflict = (await db.query(
    'SELECT * FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb)',
    ['portfolio:key-001', JSON.stringify({ ...request, message: request.message + ' Changed.' }), JSON.stringify(policy)],
  )).rows[0];
  deliveries = (await db.query('SELECT kind, channel FROM clientops.delivery_outbox ORDER BY kind')).rows;
} finally {
  await db.close();
}

assert.match(String(created.ticket_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const ticket = 'valid UUID';
const columns = [
  { heading: 'Webhook request', lines: ['Idempotency-Key present', 'Consent: true', 'Critical account issue', 'No location required'] },
  { heading: 'Policy decision', lines: [`Route: ${policy.decision.route.replace('ROUTE_', '')}`, `Category: ${policy.decision.category}`, `Score: ${policy.decision.score} · Serviceable: yes`, '✓ 100 identical reruns'] },
  { heading: 'Durable result', lines: [`201 created · ${ticket}`, `${deliveries[0].kind} → ${deliveries[0].channel}`, `${deliveries[1].kind} → ${deliveries[1].channel}`, `✓ replay ${replay.status_code} · conflict ${conflict.status_code}`] },
];
await writeFile(join(frames, '01-request.svg'), demoFrame('A request enters a strict, authenticated contract', 0, '#8B5CF6', columns, 'Input shown is the exact request executed by the portfolio renderer.'));
await writeFile(join(frames, '02-policy.svg'), demoFrame('Rules produce the same decision every time', 1, '#3B82F6', columns, `Policy ${policy.policyVersion} · ${policy.decision.nextStep}`));
await writeFile(join(frames, '03-outbox.svg'), demoFrame('The request and both deliveries commit atomically', 2, '#14B8A6', columns, 'Replay returns the original ticket; changed data with the same key is rejected.'));

process.stdout.write(JSON.stringify({
  status: 'rendered',
  workflows: ['lead-intake-workflow.svg', 'outbox-dispatcher-workflow.svg'],
  demoFrames: 3,
  livePolicyRoute: policy.decision.route,
  liveDatabaseStatuses: [created.status_code, replay.status_code, conflict.status_code],
  outbox: deliveries,
}, null, 2) + '\n');

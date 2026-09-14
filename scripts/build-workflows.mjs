import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDirectory = join(root, 'workflows', 'core');
const adapterDirectory = join(root, 'workflows', 'adapters');

const ids = {
  intake: 'clr_intake_00001',
  outbox: 'clr_outbox_00001',
  sla: 'clr_sla_mon_0001',
  digest: 'clr_digest_00001',
  contacted: 'clr_contact_0001',
  retention: 'clr_retention_001',
  errors: 'clr_errors_00001',
  saas: 'clr_saas_adapt01',
};

const credentialRefs = {
  postgres: { postgres: { id: 'clientops-postgres', name: 'ClientOps PostgreSQL' } },
  intakeApiKey: { httpHeaderAuth: { id: 'clientops-intake-api-key', name: 'ClientOps Intake API Key' } },
  adminApiKey: { httpHeaderAuth: { id: 'clientops-admin-api-key', name: 'ClientOps Admin API Key' } },
  smtp: { smtp: { id: 'clientops-smtp', name: 'ClientOps SMTP' } },
};

const nodeVersions = {
  webhook: 2.1,
  respond: 1.5,
  if: 2.3,
  switch: 3.4,
  set: 3.5,
  code: 2,
  http: 4.5,
  postgres: 2.7,
  email: 2.1,
  error: 1,
  schedule: 1.3,
  manual: 1,
  executeTrigger: 1.2,
  sheets: 4.7,
  slack: 2.5,
  gmail: 2.2,
};

function makeNode(id, name, type, typeVersion, position, parameters, extra = {}) {
  return { id, name, type, typeVersion, position, parameters, ...extra };
}

function codeNode(id, name, position, jsCode) {
  return makeNode(id, name, 'n8n-nodes-base.code', nodeVersions.code, position, {
    mode: 'runOnceForAllItems',
    language: 'javaScript',
    jsCode,
  });
}

function postgresNode(id, name, position, query, replacements, extra = {}) {
  return makeNode(
    id,
    name,
    'n8n-nodes-base.postgres',
    nodeVersions.postgres,
    position,
    {
      operation: 'executeQuery',
      query,
      options: replacements ? { queryReplacement: replacements } : {},
    },
    { credentials: credentialRefs.postgres, ...extra },
  );
}

function booleanIf(id, name, position, expression) {
  return makeNode(id, name, 'n8n-nodes-base.if', nodeVersions.if, position, {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 3,
      },
      conditions: [{
        id: `${id}-condition`,
        leftValue: expression,
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  });
}

function webhookNode(id, name, position, path, webhookId, credentials) {
  return makeNode(
    id,
    name,
    'n8n-nodes-base.webhook',
    nodeVersions.webhook,
    position,
    {
      authentication: 'headerAuth',
      httpMethod: 'POST',
      path,
      responseMode: 'responseNode',
      options: {},
    },
    { credentials, webhookId },
  );
}

function respondNode(id, name, position) {
  return makeNode(id, name, 'n8n-nodes-base.respondToWebhook', nodeVersions.respond, position, {
    respondWith: 'json',
    responseBody: '={{ $json.response }}',
    options: { responseCode: '={{ $json.statusCode }}' },
  });
}

function automaticSettings(timeout = 60) {
  return {
    executionOrder: 'v1',
    errorWorkflow: ids.errors,
    saveDataErrorExecution: 'none',
    saveDataSuccessExecution: 'none',
    saveManualExecutions: false,
    saveExecutionProgress: false,
    executionTimeout: timeout,
  };
}

function workflow(id, name, nodes, connections, settings = automaticSettings()) {
  return {
    id,
    name,
    active: false,
    nodes,
    connections,
    settings,
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

function target(node, index = 0) {
  return { node, type: 'main', index };
}

const validateLeadCode = `const items = $input.all();
return items.map((item) => {
  const request = item.json ?? {};
  const headers = request.headers ?? {};
  const body = request.body;
  const errors = [];
  const key = String(headers['idempotency-key'] ?? '').trim();
  const control = /[\\u0000-\\u001f\\u007f]/;
  const allowed = new Set(['name', 'email', 'city', 'phone', 'source', 'message', 'consent']);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) errors.push('Idempotency-Key must be 8-128 safe characters');
  if (!body || Array.isArray(body) || typeof body !== 'object') errors.push('body must be a JSON object');
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const field of Object.keys(body)) if (!allowed.has(field)) errors.push('unknown field: ' + field);
    const checks = [
      ['name', true, 159], ['email', true, 255], ['city', false, 127],
      ['phone', false, 63], ['source', false, 95], ['message', true, 8191],
    ];
    for (const [field, required, max] of checks) {
      const value = body[field];
      if ((value === undefined || value === '') && required) errors.push(field + ' is required');
      if (value !== undefined && typeof value !== 'string') errors.push(field + ' must be a string');
      if (typeof value === 'string' && value.length > max) errors.push(field + ' exceeds ' + max + ' characters');
    }
    if (body.consent !== true) errors.push('consent must be true');
    if (typeof body.name === 'string' && control.test(body.name)) errors.push('name contains control characters');
    if (typeof body.city === 'string' && control.test(body.city)) errors.push('city contains control characters');
    if (typeof body.source === 'string' && control.test(body.source)) errors.push('source contains control characters');
    if (typeof body.email === 'string') {
      const email = body.email.trim();
      const at = email.indexOf('@');
      const valid = email.length >= 3 && email.length <= 254 && !control.test(email)
        && at > 0 && at === email.lastIndexOf('@') && email.indexOf('.', at + 2) > at + 1
        && !email.endsWith('.');
      if (!valid) errors.push('email is invalid');
    }
    if (JSON.stringify(body).length > 30000) errors.push('body exceeds the 30 KB workflow limit');
  }
  if (errors.length) {
    return { json: { valid: false, statusCode: 422, response: {
      ok: false, error: { code: 'invalid_request', message: 'Request validation failed', details: errors.slice(0, 12) }
    } } };
  }
  return { json: {
    valid: true,
    idempotencyKey: key,
    policyRequest: {
      leadId: key.slice(0, 31),
      channel: 'webhook',
      name: body.name,
      city: body.city ?? '',
      phone: body.phone ?? '',
      email: body.email,
      source: body.source ?? 'webhook',
      message: body.message,
      consent: true,
    },
  } };
});`;

const evaluatePolicyCode = `return $input.all().map((item) => {
  const status = Number(item.json.statusCode ?? 0);
  const body = item.json.body;
  if (status === 200 && body && body.ok === true) {
    return { json: { accepted: true, policy: body }, pairedItem: item.pairedItem };
  }
  const validation = status === 422;
  return { json: {
    accepted: false,
    statusCode: validation ? 422 : 503,
    response: validation
      ? { ok: false, error: { code: 'invalid_request', message: body?.error?.message ?? 'Request data was rejected' } }
      : { ok: false, error: { code: 'service_unavailable', message: 'Request intake is temporarily unavailable' } },
  }, pairedItem: item.pairedItem };
});`;

const unavailableCode = `return $input.all().map(() => ({ json: {
  statusCode: 503,
  response: { ok: false, error: { code: 'service_unavailable', message: 'Request intake is temporarily unavailable' } },
} }));`;

const publicLeadResponseCode = `return $input.all().map((item) => {
  const statusCode = Number(item.json.statusCode);
  const response = statusCode === 409
    ? { ok: false, error: { code: 'idempotency_conflict', message: item.json.message } }
    : {
        ok: true,
        outcome: item.json.outcome,
        ticketId: item.json.ticketId,
        message: item.json.message,
      };
  return { json: { statusCode, response }, pairedItem: item.pairedItem };
});`;

const intakeNodes = [
  webhookNode('intake-webhook', 'Request Webhook', [0, 240], 'clientops/leads', 'clientops-lead-intake-v1', credentialRefs.intakeApiKey),
  codeNode('intake-validate', 'Validate Request', [240, 240], validateLeadCode),
  booleanIf('intake-is-valid', 'Request Valid?', [480, 240], '={{ $json.valid }}'),
  makeNode(
    'intake-policy',
    'Qualify Deterministically',
    'n8n-nodes-base.httpRequest',
    nodeVersions.http,
    [720, 120],
    {
      method: 'POST',
      url: 'http://policy:8080/v2/qualify',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ $json.policyRequest }}',
      options: {
        timeout: 5000,
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } },
      },
    },
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'continueErrorOutput' },
  ),
  codeNode('intake-evaluate-policy', 'Evaluate Policy Response', [960, 120], evaluatePolicyCode),
  booleanIf('intake-policy-accepted', 'Policy Accepted?', [1200, 120], '={{ $json.accepted }}'),
  postgresNode(
    'intake-store',
    'Store Request and Outbox',
    [1440, 40],
    `SELECT
       status_code AS "statusCode",
       outcome,
       ticket_id AS "ticketId",
       public_message AS "message",
       priority,
       route,
       sla_due_at AS "slaDueAt"
     FROM clientops.ingest_lead($1, $2::jsonb, $3::jsonb);`,
    "={{ [ $('Validate Request').item.json.idempotencyKey, JSON.stringify($('Validate Request').item.json.policyRequest), JSON.stringify($json.policy) ] }}",
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'continueErrorOutput' },
  ),
  codeNode('intake-public-response', 'Build Public Response', [1680, 40], publicLeadResponseCode),
  codeNode('intake-unavailable', 'Build Unavailable Response', [1440, 360], unavailableCode),
  respondNode('intake-respond', 'Respond to Client', [1920, 240]),
];

const intakeConnections = {
  'Request Webhook': { main: [[target('Validate Request')]] },
  'Validate Request': { main: [[target('Request Valid?')]] },
  'Request Valid?': { main: [[target('Qualify Deterministically')], [target('Respond to Client')]] },
  'Qualify Deterministically': { main: [[target('Evaluate Policy Response')], [target('Build Unavailable Response')]] },
  'Evaluate Policy Response': { main: [[target('Policy Accepted?')]] },
  'Policy Accepted?': { main: [[target('Store Request and Outbox')], [target('Respond to Client')]] },
  'Store Request and Outbox': { main: [[target('Build Public Response')], [target('Build Unavailable Response')]] },
  'Build Public Response': { main: [[target('Respond to Client')]] },
  'Build Unavailable Response': { main: [[target('Respond to Client')]] },
};

const channelCondition = (id, value) => ({
  outputKey: value,
  renameOutput: true,
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
    conditions: [{
      id,
      leftValue: '={{ $json.channel }}',
      rightValue: value,
      operator: { type: 'string', operation: 'equals' },
    }],
    combinator: 'and',
  },
});

const prepareDeliveryFailureCode = `return $input.all().map((item) => {
  const claim = $('Claim Outbox').item.json;
  const raw = item.json?.error?.message ?? item.json?.message ?? item.json?.error ?? 'unsupported delivery channel';
  return { json: {
    outboxId: claim.outbox_id,
    worker: claim.lease_owner,
    leaseToken: claim.lease_token,
    error: String(raw).slice(0, 1800),
  }, pairedItem: item.pairedItem };
});`;

const outboxNodes = [
  makeNode('outbox-schedule', 'Every Minute', 'n8n-nodes-base.scheduleTrigger', nodeVersions.schedule, [0, 80], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
  }),
  makeNode('outbox-manual', 'Run Dispatcher Manually', 'n8n-nodes-base.manualTrigger', nodeVersions.manual, [0, 280], {}),
  makeNode('outbox-worker', 'Worker Identity', 'n8n-nodes-base.set', nodeVersions.set, [240, 180], {
    mode: 'manual',
    assignments: { assignments: [
      { id: 'outbox-worker-id', name: 'workerId', value: "={{ 'outbox-' + $execution.id }}", type: 'string' },
      { id: 'outbox-batch-limit', name: 'limit', value: 20, type: 'number' },
    ] },
    includeOtherFields: false,
    options: {},
  }),
  postgresNode(
    'outbox-claim',
    'Claim Outbox',
    [480, 180],
    'SELECT * FROM clientops.claim_outbox($1, $2);',
    '={{ [ $json.workerId, $json.limit ] }}',
  ),
  postgresNode(
    'outbox-authorize',
    'Authorize Claimed Delivery',
    [700, 180],
    'SELECT * FROM clientops.authorize_delivery($1::uuid, $2::uuid);',
    '={{ [ $json.outbox_id, $json.lease_token ] }}',
  ),
  codeNode('outbox-restore-claim', 'Restore Claimed Delivery', [920, 180], `return $input.all().map((item) => ({
  json: { ...$('Claim Outbox').item.json, ...item.json },
  pairedItem: item.pairedItem,
}));`),
  booleanIf('outbox-current', 'Delivery Still Current?', [1140, 180], '={{ $json.allowed }}'),
  makeNode('outbox-switch', 'Route Delivery Channel', 'n8n-nodes-base.switch', nodeVersions.switch, [1360, 180], {
    mode: 'rules',
    rules: { values: [
      channelCondition('outbox-smtp-condition', 'smtp'),
      channelCondition('outbox-ntfy-condition', 'ntfy'),
    ] },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'unsupported' },
  }),
  makeNode(
    'outbox-email',
    'Send via SMTP',
    'n8n-nodes-base.emailSend',
    nodeVersions.email,
    [1600, 40],
    {
      fromEmail: 'ClientOps Relay <no-reply@clientops.local>',
      toEmail: '={{ $json.recipient }}',
      subject: '={{ $json.subject }}',
      emailFormat: 'text',
      text: '={{ $json.body }}',
      options: { appendAttribution: false },
    },
    { credentials: credentialRefs.smtp, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'continueErrorOutput' },
  ),
  makeNode(
    'outbox-ntfy',
    'Send via ntfy',
    'n8n-nodes-base.httpRequest',
    nodeVersions.http,
    [1600, 180],
    {
      method: 'POST',
      url: "={{ 'http://ntfy:80/' + encodeURIComponent($json.recipient) }}",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Title', value: '={{ $json.subject }}' },
        { name: 'Priority', value: "={{ $json.priority === 'high' ? '5' : $json.priority === 'low' ? '2' : '3' }}" },
        { name: 'Tags', value: 'briefcase,inbox_tray' },
      ] },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/plain',
      body: '={{ $json.body }}',
      options: { timeout: 10000, response: { response: { neverError: false, responseFormat: 'json' } } },
    },
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'continueErrorOutput' },
  ),
  postgresNode(
    'outbox-complete',
    'Complete Delivery',
    [1840, 100],
    'SELECT * FROM clientops.complete_outbox($1::uuid, $2, $3::uuid, $4);',
    "={{ [ $('Claim Outbox').item.json.outbox_id, $('Claim Outbox').item.json.lease_owner, $('Claim Outbox').item.json.lease_token, String($json.messageId ?? $json.id ?? '') ] }}",
  ),
  codeNode('outbox-prepare-failure', 'Prepare Delivery Failure', [1840, 300], prepareDeliveryFailureCode),
  postgresNode(
    'outbox-fail',
    'Defer or Dead-Letter',
    [2080, 300],
    'SELECT * FROM clientops.fail_outbox($1::uuid, $2, $3::uuid, $4);',
    '={{ [ $json.outboxId, $json.worker, $json.leaseToken, $json.error ] }}',
  ),
];

const outboxConnections = {
  'Every Minute': { main: [[target('Worker Identity')]] },
  'Run Dispatcher Manually': { main: [[target('Worker Identity')]] },
  'Worker Identity': { main: [[target('Claim Outbox')]] },
  'Claim Outbox': { main: [[target('Authorize Claimed Delivery')]] },
  'Authorize Claimed Delivery': { main: [[target('Restore Claimed Delivery')]] },
  'Restore Claimed Delivery': { main: [[target('Delivery Still Current?')]] },
  'Delivery Still Current?': { main: [[target('Route Delivery Channel')], []] },
  'Route Delivery Channel': { main: [
    [target('Send via SMTP')],
    [target('Send via ntfy')],
    [target('Prepare Delivery Failure')],
  ] },
  'Send via SMTP': { main: [[target('Complete Delivery')], [target('Prepare Delivery Failure')]] },
  'Send via ntfy': { main: [[target('Complete Delivery')], [target('Prepare Delivery Failure')]] },
  'Prepare Delivery Failure': { main: [[target('Defer or Dead-Letter')]] },
};

function scheduledDatabaseWorkflow({ id, name, manualName, scheduleName, interval, queryName, query, position = 200 }) {
  const nodes = [
    makeNode(`${id}-schedule`, scheduleName, 'n8n-nodes-base.scheduleTrigger', nodeVersions.schedule, [0, 80], {
      rule: { interval: [interval] },
    }),
    makeNode(`${id}-manual`, manualName, 'n8n-nodes-base.manualTrigger', nodeVersions.manual, [0, 280], {}),
    postgresNode(`${id}-query`, queryName, [position, 180], query, null),
  ];
  const connections = {
    [scheduleName]: { main: [[target(queryName)]] },
    [manualName]: { main: [[target(queryName)]] },
  };
  return workflow(id, name, nodes, connections);
}

const slaWorkflow = scheduledDatabaseWorkflow({
  id: ids.sla,
  name: 'ClientOps Relay — SLA Monitor',
  scheduleName: 'Every Five Minutes',
  manualName: 'Run SLA Check Manually',
  interval: { field: 'minutes', minutesInterval: 5 },
  queryName: 'Queue Overdue Escalations',
  query: 'SELECT * FROM clientops.schedule_due_followups();',
});

const digestWorkflow = scheduledDatabaseWorkflow({
  id: ids.digest,
  name: 'ClientOps Relay — Daily Digest',
  scheduleName: 'Daily at 17:00',
  manualName: 'Run Digest Manually',
  interval: { field: 'cronExpression', expression: '0 17 * * *' },
  queryName: 'Queue Daily Digest',
  query: 'SELECT * FROM clientops.enqueue_daily_digest();',
});

const retentionWorkflow = scheduledDatabaseWorkflow({
  id: ids.retention,
  name: 'ClientOps Relay — Retention Maintenance',
  scheduleName: 'Daily at 03:10',
  manualName: 'Run Retention Manually',
  interval: { field: 'cronExpression', expression: '10 3 * * *' },
  queryName: 'Purge Expired PII',
  query: 'SELECT * FROM clientops.purge_expired_data();',
});

const validateContactCode = `return $input.all().map((item) => {
  const body = item.json?.body;
  const errors = [];
  if (!body || Array.isArray(body) || typeof body !== 'object') errors.push('body must be a JSON object');
  if (body && typeof body === 'object') {
    for (const key of Object.keys(body)) if (!['ticketId', 'note'].includes(key)) errors.push('unknown field: ' + key);
    if (typeof body.ticketId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.ticketId)) errors.push('ticketId must be a UUID');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) errors.push('note must be a string up to 1000 characters');
  }
  return errors.length
    ? { json: { valid: false, statusCode: 422, response: { ok: false, error: { code: 'invalid_request', message: 'Request validation failed', details: errors } } } }
    : { json: { valid: true, ticketId: body.ticketId, note: body.note ?? '' } };
});`;

const publicContactCode = `return $input.all().map((item) => ({ json: {
  statusCode: Number(item.json.statusCode),
  response: Number(item.json.statusCode) === 404
    ? { ok: false, error: { code: 'not_found', message: item.json.message } }
    : { ok: true, outcome: item.json.outcome, message: item.json.message },
}, pairedItem: item.pairedItem }));`;

const contactUnavailableCode = `return $input.all().map(() => ({ json: {
  statusCode: 503,
  response: { ok: false, error: { code: 'service_unavailable', message: 'Contact update is temporarily unavailable' } },
} }));`;

const contactedNodes = [
  webhookNode('contact-webhook', 'Contacted Webhook', [0, 180], 'clientops/leads/contacted', 'clientops-mark-contacted-v1', credentialRefs.adminApiKey),
  codeNode('contact-validate', 'Validate Contact Update', [240, 180], validateContactCode),
  booleanIf('contact-valid', 'Update Valid?', [480, 180], '={{ $json.valid }}'),
  postgresNode(
    'contact-store',
    'Mark Request Contacted',
    [720, 80],
    `SELECT status_code AS "statusCode", outcome, public_message AS "message"
       FROM clientops.mark_lead_contacted($1::uuid, $2);`,
    '={{ [ $json.ticketId, $json.note ] }}',
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'continueErrorOutput' },
  ),
  codeNode('contact-public', 'Build Contact Response', [960, 80], publicContactCode),
  codeNode('contact-unavailable', 'Build Contact Failure', [960, 320], contactUnavailableCode),
  respondNode('contact-respond', 'Respond to Contact Update', [1200, 180]),
];

const contactedConnections = {
  'Contacted Webhook': { main: [[target('Validate Contact Update')]] },
  'Validate Contact Update': { main: [[target('Update Valid?')]] },
  'Update Valid?': { main: [[target('Mark Request Contacted')], [target('Respond to Contact Update')]] },
  'Mark Request Contacted': { main: [[target('Build Contact Response')], [target('Build Contact Failure')]] },
  'Build Contact Response': { main: [[target('Respond to Contact Update')]] },
  'Build Contact Failure': { main: [[target('Respond to Contact Update')]] },
};

const sanitizeErrorCode = `return $input.all().map((item) => {
  const data = item.json ?? {};
  const execution = data.execution ?? {};
  const workflow = data.workflow ?? {};
  const error = execution.error ?? data.error ?? {};
  return { json: {
    workflowName: String(workflow.name ?? 'unknown').slice(0, 255),
    workflowId: String(workflow.id ?? '').slice(0, 128),
    executionId: String(execution.id ?? '').slice(0, 128),
    lastNode: String(execution.lastNodeExecuted ?? '').slice(0, 255),
    message: String(error.message ?? 'unknown workflow error').slice(0, 2000),
    context: { mode: execution.mode ?? 'unknown', retryOf: execution.retryOf ?? null },
  } };
});`;

const errorNodes = [
  makeNode('error-trigger', 'Workflow Error', 'n8n-nodes-base.errorTrigger', nodeVersions.error, [0, 160], {}),
  codeNode('error-sanitize', 'Sanitize Failure', [240, 160], sanitizeErrorCode),
  postgresNode(
    'error-store',
    'Record Failure',
    [480, 160],
    'SELECT clientops.record_workflow_failure($1, $2, $3, $4, $5, $6) AS id;',
    '={{ [ $json.workflowName, $json.workflowId, $json.executionId, $json.lastNode, $json.message, $json.context.mode ] }}',
  ),
];

const errorConnections = {
  'Workflow Error': { main: [[target('Sanitize Failure')]] },
  'Sanitize Failure': { main: [[target('Record Failure')]] },
};

const errorSettings = {
  executionOrder: 'v1',
  saveDataErrorExecution: 'none',
  saveDataSuccessExecution: 'none',
  saveManualExecutions: false,
  saveExecutionProgress: false,
  executionTimeout: 30,
};

const adapterInputExample = JSON.stringify({
  spreadsheetId: 'real-spreadsheet-id-from-caller',
  sheetName: 'Requests',
  slackChannelId: 'real-channel-id-from-caller',
  customerEmail: 'customer@business.test',
  ticketId: '00000000-0000-4000-8000-000000000000',
  name: 'Customer name',
  email: 'customer@business.test',
  phone: '',
  city: '',
  category: 'support',
  score: 90,
  serviceable: true,
  urgency: 'high',
  priority: 'high',
  route: 'ROUTE_URGENT',
  summary: 'A customer reports a critical account issue that needs support today.',
  draftReply: 'Thanks for reaching out. Our team will review your request promptly.',
}, null, 2);

const adapterNodes = [
  makeNode('adapter-trigger', 'When Called by Core Workflow', 'n8n-nodes-base.executeWorkflowTrigger', nodeVersions.executeTrigger, [0, 180], {
    inputSource: 'jsonExample',
    jsonExample: adapterInputExample,
  }),
  codeNode('adapter-sheet-safe', 'Prepare Safe Sheet Row', [240, 180], `const safe = (value) => {
  const text = String(value ?? '');
  return /^[\\s]*[=+\\-@]/u.test(text) ? "'" + text : text;
};
return $input.all().map((item) => {
  const data = item.json ?? {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(data.ticketId ?? ''))) {
    throw new Error('Adapter contract requires a UUID ticketId');
  }
  if (typeof data.category !== 'string' || data.category.length < 1 || data.category.length > 64) {
    throw new Error('Adapter contract requires a category up to 64 characters');
  }
  if (!Number.isInteger(data.score) || data.score < 0 || data.score > 100) {
    throw new Error('Adapter contract requires an integer score from 0 to 100');
  }
  if (typeof data.serviceable !== 'boolean') {
    throw new Error('Adapter contract requires a boolean serviceable value');
  }
  if (!['low', 'medium', 'high'].includes(data.urgency)) {
    throw new Error('Adapter contract requires low, medium, or high urgency');
  }
  return { json: {
    ticketId: String(data.ticketId),
    name: safe(data.name),
    email: safe(data.email),
    phone: safe(data.phone),
    city: safe(data.city),
    category: safe(data.category),
    score: data.score,
    serviceable: data.serviceable,
    urgency: safe(data.urgency),
    priority: safe(data.priority),
    route: safe(data.route),
    summary: safe(data.summary),
  } };
});`),
  makeNode('adapter-sheets', 'Upsert Request in Google Sheets', 'n8n-nodes-base.googleSheets', nodeVersions.sheets, [480, 180], {
    authentication: 'oAuth2',
    resource: 'sheet',
    operation: 'appendOrUpdate',
    documentId: { __rl: true, mode: 'id', value: "={{ $('When Called by Core Workflow').item.json.spreadsheetId }}" },
    sheetName: { __rl: true, mode: 'name', value: "={{ $('When Called by Core Workflow').item.json.sheetName }}" },
    columns: {
      mappingMode: 'autoMapInputData',
      value: {},
      matchingColumns: ['ticketId'],
      schema: [],
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
    options: { cellFormat: 'RAW', handlingExtraData: 'error' },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'stopWorkflow' }),
  codeNode('adapter-slack-safe', 'Build Safe Slack Message', [720, 180], `const escapeSlack = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');
const data = $('When Called by Core Workflow').first().json ?? {};
return [{ json: {
  slackText: '*New ' + escapeSlack(data.urgency) + ' request* — ' + escapeSlack(data.name)
    + '\\nCategory: ' + escapeSlack(data.category) + ' · Score: ' + escapeSlack(data.score)
    + '\\n' + escapeSlack(data.summary)
    + '\\nTicket: ' + escapeSlack(data.ticketId),
} }];`),
  makeNode('adapter-slack', 'Notify Slack', 'n8n-nodes-base.slack', nodeVersions.slack, [960, 180], {
    authentication: 'oAuth2',
    resource: 'message',
    operation: 'post',
    select: 'channel',
    channelId: { __rl: true, mode: 'id', value: "={{ $('When Called by Core Workflow').item.json.slackChannelId }}" },
    messageType: 'text',
    text: '={{ $json.slackText }}',
    otherOptions: {},
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'stopWorkflow' }),
  makeNode('adapter-gmail', 'Send Gmail Acknowledgement', 'n8n-nodes-base.gmail', nodeVersions.gmail, [1200, 180], {
    authentication: 'oAuth2',
    resource: 'message',
    operation: 'send',
    sendTo: "={{ $('When Called by Core Workflow').item.json.customerEmail }}",
    subject: 'We received your request',
    emailType: 'text',
    message: "={{ $('When Called by Core Workflow').item.json.draftReply }}",
    options: { appendAttribution: false },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, onError: 'stopWorkflow' }),
];

const adapterConnections = {
  'When Called by Core Workflow': { main: [[target('Prepare Safe Sheet Row')]] },
  'Prepare Safe Sheet Row': { main: [[target('Upsert Request in Google Sheets')]] },
  'Upsert Request in Google Sheets': { main: [[target('Build Safe Slack Message')]] },
  'Build Safe Slack Message': { main: [[target('Notify Slack')]] },
  'Notify Slack': { main: [[target('Send Gmail Acknowledgement')]] },
};

const workflows = [
  ['01-api-lead-intake.json', workflow(ids.intake, 'ClientOps Relay — API Request Intake', intakeNodes, intakeConnections)],
  ['20-outbox-dispatcher.json', workflow(ids.outbox, 'ClientOps Relay — Outbox Dispatcher', outboxNodes, outboxConnections, automaticSettings(120))],
  ['30-sla-monitor.json', slaWorkflow],
  ['40-daily-digest.json', digestWorkflow],
  ['50-mark-contacted.json', workflow(ids.contacted, 'ClientOps Relay — Mark Contacted', contactedNodes, contactedConnections)],
  ['60-retention-maintenance.json', retentionWorkflow],
  ['90-error-sink.json', workflow(ids.errors, 'ClientOps Relay — Error Sink', errorNodes, errorConnections, errorSettings)],
];

const adapters = [
  ['google-sheets-slack-gmail.json', workflow(ids.saas, 'ClientOps Relay — Google Sheets + Slack + Gmail Adapter', adapterNodes, adapterConnections)],
];

await mkdir(coreDirectory, { recursive: true });
await mkdir(adapterDirectory, { recursive: true });
for (const [filename, data] of workflows) {
  await writeFile(join(coreDirectory, filename), JSON.stringify(data, null, 2) + '\n');
}
for (const [filename, data] of adapters) {
  await writeFile(join(adapterDirectory, filename), JSON.stringify(data, null, 2) + '\n');
}

process.stdout.write(JSON.stringify({
  status: 'generated',
  n8n: '2.37.10',
  coreWorkflows: workflows.map(([filename]) => filename),
  optionalAdapters: adapters.map(([filename]) => filename),
}, null, 2) + '\n');

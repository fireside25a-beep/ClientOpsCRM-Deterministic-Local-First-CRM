import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(root, 'scripts', 'render-deployments.mjs');
const immutableImage = `ghcr.io/fireside25a-beep/clientops-relay-companion@sha256:${'a'.repeat(64)}`;
const rendererArguments = [
  '--companion-url', 'https://relay.clientops.test',
  '--kubernetes-image', immutableImage,
  '--kubernetes-hostname', 'relay.clientops.test',
  '--kubernetes-ingress-class', 'nginx',
  '--kubernetes-tls-secret', 'relay-clientops-tls',
  '--kubernetes-api-secret', 'clientops-relay-companion',
];

function runRenderer(outputRoot, additionalArguments = []) {
  return spawnSync(process.execPath, [renderer, '--output-root', outputRoot, ...rendererArguments, ...additionalArguments], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function fileMap(directory, prefix = '') {
  const result = new Map();
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [path, digest] of await fileMap(directory, relativePath)) result.set(path, digest);
    } else {
      const bytes = await readFile(join(directory, relativePath));
      result.set(relativePath.replaceAll('\\', '/'), createHash('sha256').update(bytes).digest('hex'));
    }
  }
  return result;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'clientops-deployment-renderers-'));
const first = join(temporaryRoot, 'first');
const second = join(temporaryRoot, 'second');

try {
  const corePath = join(root, 'workflows', 'core', '01-api-lead-intake.json');
  const coreBefore = createHash('sha256').update(await readFile(corePath)).digest('hex');
  const firstRun = runRenderer(first);
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
  const secondRun = runRenderer(second);
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  const coreAfter = createHash('sha256').update(await readFile(corePath)).digest('hex');
  assert.equal(coreAfter, coreBefore, 'renderer mutated the core workflow');
  assert.deepEqual(await fileMap(first), await fileMap(second), 'same inputs did not render byte-identical trees');

  const railway = JSON.parse(await readFile(join(first, 'deploy', 'railway', 'railway.json'), 'utf8'));
  assert.equal(railway.build.builder, 'DOCKERFILE');
  assert.equal(railway.build.dockerfilePath, 'companion/Dockerfile');
  assert.equal(railway.deploy.healthcheckPath, '/readyz');
  assert.equal(railway.deploy.restartPolicyType, 'ON_FAILURE');

  const render = await readFile(join(first, 'deploy', 'render', 'render.yaml'), 'utf8');
  assert.match(render, /runtime: docker/);
  assert.match(render, /dockerfilePath: \.\/companion\/Dockerfile/);
  assert.match(render, /healthCheckPath: \/readyz/);
  assert.match(render, /key: CLIENTOPS_COMPANION_API_KEY\n\s+sync: false/);
  assert.doesNotMatch(render, /CLIENTOPS_COMPANION_API_KEY\s*:\s*\S+/);

  const kubernetes = JSON.parse(await readFile(join(first, 'deploy', 'kubernetes', 'clientops-relay-companion.json'), 'utf8'));
  assert.equal(kubernetes.kind, 'List');
  const byKind = new Map(kubernetes.items.map((resource) => [resource.kind, resource]));
  for (const kind of ['Namespace', 'ServiceAccount', 'Deployment', 'Service', 'Ingress', 'PodDisruptionBudget']) {
    assert(byKind.has(kind), `Kubernetes output is missing ${kind}`);
  }
  const deployment = byKind.get('Deployment');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(container.image, immutableImage);
  assert.equal(container.startupProbe.httpGet.path, '/readyz');
  assert.equal(container.readinessProbe.httpGet.path, '/readyz');
  assert.equal(container.livenessProbe.httpGet.path, '/healthz');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  const apiKeyEnvironment = container.env.find((entry) => entry.name === 'CLIENTOPS_COMPANION_API_KEY');
  assert.deepEqual(apiKeyEnvironment.valueFrom.secretKeyRef, {
    name: 'clientops-relay-companion',
    key: 'api-key',
  });
  assert.equal(byKind.get('Ingress').spec.tls[0].secretName, 'relay-clientops-tls');
  assert.equal(byKind.get('Ingress').spec.rules[0].host, 'relay.clientops.test');

  const cloud = JSON.parse(await readFile(join(first, 'workflows', 'cloud', '01-api-lead-intake.json'), 'utf8'));
  assert.equal(cloud.active, false);
  assert.equal(cloud.id, 'clr_cloud_intake1');
  assert.equal(cloud.settings.saveDataErrorExecution, 'none');
  assert.equal(cloud.settings.saveDataSuccessExecution, 'none');
  assert.equal(cloud.settings.saveManualExecutions, false);
  assert.equal(cloud.settings.saveExecutionProgress, false);
  assert.equal(cloud.settings.errorWorkflow, undefined);
  const companionNode = cloud.nodes.find((node) => node.id === 'intake-policy');
  assert.equal(companionNode.parameters.url, 'https://relay.clientops.test/v2/qualify');
  assert.equal(companionNode.parameters.authentication, 'genericCredentialType');
  assert.equal(companionNode.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(companionNode.credentials.httpHeaderAuth.name, 'ClientOps Companion API Key');
  const policyGate = cloud.nodes.find((node) => node.id === 'intake-evaluate-policy').parameters.jsCode;
  assert.match(policyGate, /policyVersion === 'clientops-triage-v1'/);
  assert.match(policyGate, /Number\.isInteger\(decision\.score\)/);
  assert.match(policyGate, /routes\.has\(decision\.route\)/);
  assert.equal(cloud.nodes.find((node) => node.id === 'intake-webhook').credentials.httpHeaderAuth.name, 'ClientOps Intake API Key');
  assert.equal(cloud.nodes.find((node) => node.id === 'intake-store').credentials.postgres.name, 'ClientOps PostgreSQL');

  const allRenderedText = [...await fileMap(first)].map(([path]) => readFile(join(first, path), 'utf8'));
  const combined = (await Promise.all(allRenderedText)).join('\n');
  assert.doesNotMatch(combined, /\b(?:TODO|FIXME|CHANGEME)\b/i);
  assert.doesNotMatch(combined, /CLIENTOPS_COMPANION_API_KEY\s*=/, 'rendered output contains an inline companion credential');
  assert.doesNotMatch(combined, /"value"\s*:\s*"[a-f0-9]{64}"/i, 'rendered output contains a 64-hex value');

  const incomplete = spawnSync(process.execPath, [renderer, '--output-root', join(temporaryRoot, 'incomplete'), '--kubernetes-image', immutableImage], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(incomplete.status, 0, 'partial Kubernetes input was accepted');
  assert.match(incomplete.stderr, /missing:/);

  const insecure = spawnSync(process.execPath, [renderer, '--output-root', join(temporaryRoot, 'insecure'), '--companion-url', 'http://relay.clientops.test'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(insecure.status, 0, 'non-HTTPS companion URL was accepted');
  assert.match(insecure.stderr, /HTTPS origin/);

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    contract: 'deployment-renderers',
    providers: ['Railway', 'Kubernetes', 'Render', 'n8n Cloud'],
    deterministicTrees: 2,
    secretValuesEmbedded: false,
    companionBoundary: ['/healthz', '/readyz', '/v2/qualify'],
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

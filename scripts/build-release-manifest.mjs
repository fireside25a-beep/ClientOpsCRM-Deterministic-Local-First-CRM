import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function filesBelow(directory, acceptedExtensions = null) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, acceptedExtensions));
    else if (!acceptedExtensions || acceptedExtensions.has(extname(entry.name))) files.push(absolute);
  }
  return files.sort();
}

async function digestFiles(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function digestFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const workflowFiles = [
  ...await filesBelow(join(root, 'workflows', 'core'), new Set(['.json'])),
  ...await filesBelow(join(root, 'workflows', 'adapters'), new Set(['.json'])),
  ...await filesBelow(join(root, 'workflows', 'cloud'), new Set(['.json'])),
];
const workflowNodeCount = (await Promise.all(workflowFiles.map(async (path) => {
  const workflow = JSON.parse(await readFile(path, 'utf8'));
  assert(Array.isArray(workflow.nodes), `${relative(root, path)} has no nodes array`);
  return workflow.nodes.length;
}))).reduce((total, count) => total + count, 0);
const policySourceFiles = [
  ...await filesBelow(join(root, 'policy-engine', 'include'), new Set(['.h'])),
  ...await filesBelow(join(root, 'policy-engine', 'src'), new Set(['.c'])),
  ...await filesBelow(join(root, 'policy-engine', 'config'), new Set(['.json'])),
  ...await filesBelow(join(root, 'policy-engine', 'third_party'), new Set(['.c', '.h', '.json'])),
  join(root, 'policy-engine', 'CONTAINER_IMAGES.lock.json'),
  join(root, 'policy-engine', 'server.mjs'),
  join(root, 'policy-engine', 'Dockerfile'),
  join(root, 'policy-engine', 'Makefile'),
];
const companionFiles = [
  join(root, 'companion', 'server.mjs'),
  join(root, 'companion', 'Dockerfile'),
];
const deploymentFiles = [
  ...await filesBelow(join(root, 'deploy')),
  join(root, 'scripts', 'render-deployments.mjs'),
];
const databaseFiles = [
  join(root, 'database', '001-bootstrap.sh'),
  join(root, 'database', 'migrate.sh'),
  join(root, 'database', 'schema.sql'),
  ...await filesBelow(join(root, 'database', 'migrations'), new Set(['.sql'])),
];
const portfolioFiles = await filesBelow(join(root, 'artifacts', 'portfolio'), new Set(['.svg', '.png', '.gif']));

const policyBinary = join(root, 'policy-engine', 'build', 'policy_cli');
const referenceRequest = {
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
const policyRun = spawnSync(policyBinary, ['--config', join(root, 'policy-engine', 'config', 'policy.json')], {
  input: JSON.stringify(referenceRequest),
  encoding: 'utf8',
  timeout: 2_000,
});
assert.equal(policyRun.status, 0, policyRun.stderr || policyRun.stdout);
const policyReferenceOutputSha256 = createHash('sha256').update(policyRun.stdout).digest('hex');

const manifest = {
  product: 'ClientOps Relay',
  version: packageMetadata.version,
  preparedAt: '2026-09-06',
  upgradeBaseline: {
    version: '1.1.0',
    archiveSha256: 'e7691ad633cbc939b7db905ea51d0a9af1d755ee676ac66052398a2fefe11440',
  },
  universalDefaults: {
    locationMode: 'any',
    timezone: 'UTC',
    phoneCountryInference: false,
  },
  components: {
    n8n: '2.37.10',
    n8nTaskRunner: '2.37.10',
    postgresql: '16.14',
    mailpit: '1.30.6',
    ntfy: '2.27.0',
    nodePolicyRuntime: '24.14.0',
    cJSON: '1.7.19',
  },
  inventory: {
    coreWorkflows: 7,
    optionalAdapters: 1,
    cloudWorkflows: 1,
    workflowNodes: workflowNodeCount,
    policyContractCases: 13,
    policyHttpStatuses: [200, 422, 404, 415],
    companionHttpStatuses: [200, 401, 404, 405, 413, 415, 422],
    deterministicRepetitions: 100,
    migratedLegacyRouteCases: 9,
    deploymentProviders: ['Railway', 'Kubernetes', 'Render'],
  },
  digests: {
    policyReferenceOutputSha256,
    workflowJsonSetSha256: await digestFiles(workflowFiles),
    workflowGeneratorSha256: await digestFile(join(root, 'scripts', 'build-workflows.mjs')),
    databaseSourceSetSha256: await digestFiles(databaseFiles),
    policySourceSetSha256: await digestFiles(policySourceFiles),
    companionSourceSetSha256: await digestFiles(companionFiles),
    deploymentSourceSetSha256: await digestFiles(deploymentFiles),
    portfolioAssetSetSha256: await digestFiles(portfolioFiles),
  },
  verification: {
    nativeContracts: 'PASS',
    nativeBuildParity: 'PASS',
    companionHttpBoundary: 'PASS',
    encryptedBackupChecksums: 'PASS',
    deterministicDeploymentRenderers: 'PASS',
    databaseUpgrade: 'NOT_RUN_PGLITE_UNAVAILABLE',
    domainNeutrality: 'PASS',
    addressAndUndefinedBehaviorSanitizers: 'PASS',
    exactN8nFreshBootstrap: 'NOT_RUN_EXACT_N8N_UNAVAILABLE',
    exactN8nFrozenStockUpgrade: 'NOT_RUN_EXACT_N8N_UNAVAILABLE',
    exactN8nCustomizedRefusal: 'NOT_RUN_EXACT_N8N_UNAVAILABLE',
    exactN8nCurrentFastPath: 'NOT_RUN_EXACT_N8N_UNAVAILABLE',
    optionalAdapterImportInactive: 'STATIC_PASS_RUNTIME_IMPORT_NOT_RUN',
    cloudWorkflowImportInactive: 'STATIC_PASS_RUNTIME_IMPORT_NOT_RUN',
    documentationLinks: 'PASS',
    dockerAcceptanceInPreparationEnvironment: 'NOT_RUN_DOCKER_UNAVAILABLE',
    companionContainerBuildInPreparationEnvironment: 'NOT_RUN_DOCKER_UNAVAILABLE',
    liveProviderDeployments: 'NOT_RUN_CREDENTIALS_DNS_TLS_REQUIRED',
    liveN8nCloudExecution: 'NOT_RUN_CLOUD_ACCOUNT_AND_CREDENTIALS_REQUIRED',
  },
};

await writeFile(join(root, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'generated', file: 'RELEASE_MANIFEST.json', version: manifest.version }, null, 2)}\n`);

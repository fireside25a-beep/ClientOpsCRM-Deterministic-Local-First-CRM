import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

const knownOptions = new Set([
  'output-root',
  'companion-url',
  'kubernetes-image',
  'kubernetes-hostname',
  'kubernetes-ingress-class',
  'kubernetes-tls-secret',
  'kubernetes-api-secret',
  'kubernetes-image-pull-secret',
  'kubernetes-namespace',
]);

function usage() {
  return `Usage: node scripts/render-deployments.mjs [options]

Always renders:
  deploy/railway/railway.json
  deploy/render/render.yaml
  workflows/cloud/01-api-lead-intake.json

Kubernetes is rendered when all four required Kubernetes inputs are supplied:
  --kubernetes-image OCI_IMAGE@sha256:DIGEST
  --kubernetes-hostname PUBLIC_DNS_NAME
  --kubernetes-ingress-class INGRESS_CLASS
  --kubernetes-tls-secret TLS_SECRET_NAME

Optional:
  --output-root DIRECTORY
  --companion-url HTTPS_BASE_URL
  --kubernetes-api-secret SECRET_NAME
  --kubernetes-image-pull-secret SECRET_NAME
  --kubernetes-namespace NAMESPACE
`;
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true, options };
    if (!argument.startsWith('--')) throw new Error(`unexpected positional argument: ${argument}`);
    const key = argument.slice(2);
    if (!knownOptions.has(key)) throw new Error(`unknown option: --${key}`);
    if (options.has(key)) throw new Error(`duplicate option: --${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options.set(key, value);
    index += 1;
  }
  return { help: false, options };
}

function requireKubernetesName(value, label) {
  if (!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value) || value.length > 253) {
    throw new Error(`${label} must be a valid Kubernetes DNS subdomain`);
  }
  return value;
}

function requireDnsHostname(value) {
  const hostname = value.toLowerCase();
  if (hostname !== value || hostname.length > 253 || hostname.endsWith('.')) {
    throw new Error('--kubernetes-hostname must be a lowercase, fully qualified DNS name without a trailing dot');
  }
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('--kubernetes-hostname must be a lowercase, fully qualified DNS name');
  }
  return hostname;
}

function requireImmutableImage(value) {
  if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('--kubernetes-image must be an immutable OCI image reference ending in @sha256:<64 lowercase hex characters>');
  }
  return value;
}

function requireHttpsBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--companion-url must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--companion-url must be an HTTPS origin without credentials, query, or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('--companion-url must not contain a path');
  }
  return parsed.origin;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.rendering-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o644 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function railwayManifest() {
  return stableJson({
    $schema: 'https://railway.com/railway.schema.json',
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'companion/Dockerfile',
      watchPatterns: [
        '/companion/**',
        '/policy-engine/**',
      ],
    },
    deploy: {
      healthcheckPath: '/readyz',
      healthcheckTimeout: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  });
}

function renderBlueprint() {
  return `services:
  - type: web
    name: clientops-relay-companion
    runtime: docker
    plan: starter
    dockerfilePath: ./companion/Dockerfile
    dockerContext: .
    healthCheckPath: /readyz
    autoDeployTrigger: checksPass
    maxShutdownDelaySeconds: 30
    envVars:
      - key: CLIENTOPS_COMPANION_API_KEY
        sync: false
`;
}

function objectMetadata(name, namespace, component) {
  return {
    name,
    namespace,
    labels: {
      'app.kubernetes.io/name': 'clientops-relay',
      'app.kubernetes.io/instance': 'clientops-relay',
      'app.kubernetes.io/component': component,
      'app.kubernetes.io/version': packageMetadata.version,
      'app.kubernetes.io/managed-by': 'clientops-deployment-renderer',
    },
  };
}

function kubernetesManifest(inputs) {
  const podLabels = {
    'app.kubernetes.io/name': 'clientops-relay',
    'app.kubernetes.io/instance': 'clientops-relay',
    'app.kubernetes.io/component': 'companion',
  };
  const podSpec = {
    serviceAccountName: 'clientops-relay-companion',
    automountServiceAccountToken: false,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [{
      name: 'companion',
      image: inputs.image,
      imagePullPolicy: 'IfNotPresent',
      ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
      env: [
        { name: 'HOST', value: '0.0.0.0' },
        { name: 'PORT', value: '8080' },
        {
          name: 'CLIENTOPS_COMPANION_API_KEY',
          valueFrom: {
            secretKeyRef: { name: inputs.apiSecret, key: 'api-key' },
          },
        },
      ],
      startupProbe: {
        httpGet: { path: '/readyz', port: 'http', scheme: 'HTTP' },
        periodSeconds: 2,
        timeoutSeconds: 2,
        failureThreshold: 30,
      },
      readinessProbe: {
        httpGet: { path: '/readyz', port: 'http', scheme: 'HTTP' },
        periodSeconds: 5,
        timeoutSeconds: 2,
        failureThreshold: 3,
      },
      livenessProbe: {
        httpGet: { path: '/healthz', port: 'http', scheme: 'HTTP' },
        periodSeconds: 10,
        timeoutSeconds: 2,
        failureThreshold: 3,
      },
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
    }],
    volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '16Mi' } }],
    terminationGracePeriodSeconds: 30,
  };
  if (inputs.imagePullSecret) {
    podSpec.imagePullSecrets = [{ name: inputs.imagePullSecret }];
  }

  return {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: inputs.namespace,
          labels: {
            'app.kubernetes.io/name': 'clientops-relay',
            'app.kubernetes.io/managed-by': 'clientops-deployment-renderer',
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: objectMetadata('clientops-relay-companion', inputs.namespace, 'companion'),
        automountServiceAccountToken: false,
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: objectMetadata('clientops-relay-companion', inputs.namespace, 'companion'),
        spec: {
          replicas: 2,
          revisionHistoryLimit: 3,
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
          },
          selector: { matchLabels: podLabels },
          template: {
            metadata: { labels: podLabels },
            spec: podSpec,
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: objectMetadata('clientops-relay-companion', inputs.namespace, 'companion'),
        spec: {
          type: 'ClusterIP',
          selector: podLabels,
          ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }],
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: objectMetadata('clientops-relay-companion', inputs.namespace, 'companion'),
        spec: {
          ingressClassName: inputs.ingressClass,
          tls: [{ hosts: [inputs.hostname], secretName: inputs.tlsSecret }],
          rules: [{
            host: inputs.hostname,
            http: {
              paths: [{
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'clientops-relay-companion', port: { name: 'http' } },
                },
              }],
            },
          }],
        },
      },
      {
        apiVersion: 'policy/v1',
        kind: 'PodDisruptionBudget',
        metadata: objectMetadata('clientops-relay-companion', inputs.namespace, 'companion'),
        spec: {
          minAvailable: 1,
          selector: { matchLabels: podLabels },
        },
      },
    ],
  };
}

async function cloudWorkflow(companionUrl) {
  const workflow = JSON.parse(await readFile(join(projectRoot, 'workflows', 'core', '01-api-lead-intake.json'), 'utf8'));
  workflow.id = 'clr_cloud_intake1';
  workflow.name = 'ClientOps Relay - Cloud API Intake';
  workflow.active = false;
  delete workflow.settings.errorWorkflow;

  const webhook = workflow.nodes.find((node) => node.id === 'intake-webhook');
  if (!webhook) throw new Error('core intake workflow is missing intake-webhook');
  webhook.webhookId = 'clientops-cloud-lead-intake-v1';

  const policyNode = workflow.nodes.find((node) => node.id === 'intake-policy');
  if (!policyNode) throw new Error('core intake workflow is missing intake-policy');
  policyNode.parameters.url = companionUrl
    ? `${companionUrl}/v2/qualify`
    : "={{ $vars.CLIENTOPS_COMPANION_URL.replace(/\\\/$/, '') + '/v2/qualify' }}";
  policyNode.parameters.authentication = 'genericCredentialType';
  policyNode.parameters.genericAuthType = 'httpHeaderAuth';
  policyNode.credentials = {
    httpHeaderAuth: {
      id: 'clientops-companion-api-key',
      name: 'ClientOps Companion API Key',
    },
  };

  const evaluateNode = workflow.nodes.find((node) => node.id === 'intake-evaluate-policy');
  if (!evaluateNode) throw new Error('core intake workflow is missing intake-evaluate-policy');
  evaluateNode.parameters.jsCode = `return $input.all().map((item) => {
  const status = Number(item.json.statusCode ?? 0);
  const body = item.json.body;
  const decision = body?.decision;
  const routes = new Set([
    'ROUTE_URGENT', 'ROUTE_SPECIALIST', 'ROUTE_STANDARD', 'ROUTE_SPAM',
    'ROUTE_UNSUPPORTED', 'ROUTE_INSUFFICIENT_INFORMATION',
    'ROUTE_MANUAL_REVIEW', 'ROUTE_LOCATION_REVIEW',
  ]);
  const policyShapeValid = body && !Array.isArray(body) && typeof body === 'object'
    && body.ok === true
    && body.policyVersion === 'clientops-triage-v1'
    && decision && !Array.isArray(decision) && typeof decision === 'object'
    && typeof decision.fit === 'boolean'
    && typeof decision.fitReason === 'string'
    && typeof decision.category === 'string' && decision.category.length > 0
    && Number.isInteger(decision.score) && decision.score >= 0 && decision.score <= 100
    && typeof decision.serviceable === 'boolean'
    && ['low', 'medium', 'high'].includes(decision.urgency)
    && typeof decision.summary === 'string'
    && typeof decision.nextStep === 'string'
    && typeof decision.draftReply === 'string'
    && routes.has(decision.route);
  if (status === 200 && policyShapeValid) {
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
  return workflow;
}

const { help, options } = parseArguments(process.argv.slice(2));
if (help) {
  process.stdout.write(usage());
  process.exit(0);
}

const outputRootValue = options.get('output-root') ?? projectRoot;
const outputRoot = isAbsolute(outputRootValue) ? outputRootValue : resolve(process.cwd(), outputRootValue);
const companionUrl = options.has('companion-url') ? requireHttpsBaseUrl(options.get('companion-url')) : undefined;

const kubernetesRequired = [
  'kubernetes-image',
  'kubernetes-hostname',
  'kubernetes-ingress-class',
  'kubernetes-tls-secret',
];
const suppliedKubernetesInputs = kubernetesRequired.filter((key) => options.has(key));
if (suppliedKubernetesInputs.length !== 0 && suppliedKubernetesInputs.length !== kubernetesRequired.length) {
  const missing = kubernetesRequired.filter((key) => !options.has(key));
  throw new Error(`Kubernetes rendering requires all deployment inputs; missing: ${missing.map((key) => `--${key}`).join(', ')}`);
}

const outputs = [
  [join(outputRoot, 'deploy', 'railway', 'railway.json'), railwayManifest()],
  [join(outputRoot, 'deploy', 'render', 'render.yaml'), renderBlueprint()],
  [join(outputRoot, 'workflows', 'cloud', '01-api-lead-intake.json'), stableJson(await cloudWorkflow(companionUrl))],
];

if (suppliedKubernetesInputs.length === kubernetesRequired.length) {
  const inputs = {
    image: requireImmutableImage(options.get('kubernetes-image')),
    hostname: requireDnsHostname(options.get('kubernetes-hostname')),
    ingressClass: requireKubernetesName(options.get('kubernetes-ingress-class'), '--kubernetes-ingress-class'),
    tlsSecret: requireKubernetesName(options.get('kubernetes-tls-secret'), '--kubernetes-tls-secret'),
    apiSecret: requireKubernetesName(options.get('kubernetes-api-secret') ?? 'clientops-relay-companion', '--kubernetes-api-secret'),
    namespace: requireKubernetesName(options.get('kubernetes-namespace') ?? 'clientops-relay', '--kubernetes-namespace'),
    imagePullSecret: options.has('kubernetes-image-pull-secret')
      ? requireKubernetesName(options.get('kubernetes-image-pull-secret'), '--kubernetes-image-pull-secret')
      : undefined,
  };
  outputs.push([
    join(outputRoot, 'deploy', 'kubernetes', 'clientops-relay-companion.json'),
    stableJson(kubernetesManifest(inputs)),
  ]);
}

for (const [path, content] of outputs) await atomicWrite(path, content);

process.stdout.write(stableJson({
  status: 'PASS',
  deterministic: true,
  cloudCompanionUrlSource: companionUrl ? 'render-input' : 'n8n-variable',
  files: outputs.map(([path]) => path.slice(outputRoot.length + 1).replaceAll('\\', '/')),
}));

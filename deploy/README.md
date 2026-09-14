# Deployment renderers

The companion is the only application component deployed by these provider manifests. It exposes the compiled deterministic policy through `POST /v2/qualify`, reports process liveness at `GET /healthz`, and reports policy readiness at `GET /readyz`. n8n Cloud runs the generated intake workflow, while a reachable initialized ClientOps PostgreSQL database remains the system of record.

Run the renderer from the repository root:

```bash
node scripts/render-deployments.mjs
```

This writes the Railway and Render source-build manifests and the n8n Cloud workflow. Repeating the command with the same source and inputs produces byte-identical files.

## Inputs that are intentionally external

| Input | Where it is supplied | Constraint |
|---|---|---|
| Companion API key | Railway variable, Render secret prompt, or Kubernetes Secret key `api-key` | Exactly 64 hexadecimal characters; use the same value in the n8n HTTP Header Auth credential |
| Companion public URL | n8n variable `CLIENTOPS_COMPANION_URL`, or renderer `--companion-url` | Public HTTPS origin with no path, query, credentials, or fragment |
| Kubernetes image | `--kubernetes-image` | Published OCI reference pinned by `@sha256:` digest |
| Kubernetes hostname | `--kubernetes-hostname` | Lowercase public DNS name routed to the selected ingress controller |
| Kubernetes ingress class | `--kubernetes-ingress-class` | An installed ingress class, such as the name used by the cluster's controller |
| Kubernetes TLS secret | `--kubernetes-tls-secret` | Existing TLS Secret valid for the public hostname |
| Kubernetes API secret | `--kubernetes-api-secret` | Existing Secret whose `api-key` entry contains the 64-character companion key |
| Kubernetes pull secret | `--kubernetes-image-pull-secret` | Existing registry Secret; omit for a public image |

No credential value is written into a workflow or provider manifest.

## Railway

Create a service from this repository and set its config-as-code path to `/deploy/railway/railway.json`. Add a sealed service variable named `CLIENTOPS_COMPANION_API_KEY`, then enable a public domain. Railway supplies `PORT`; the companion binds to it on `0.0.0.0`. The manifest builds `companion/Dockerfile` from the repository and gates a deployment on `/readyz`.

After Railway assigns the domain, set the n8n input to `https://` followed by that domain.

## Render

Create a Blueprint and select `deploy/render/render.yaml` as its Blueprint path. On first creation, Render prompts for `CLIENTOPS_COMPANION_API_KEY` because the field is declared with `sync: false`. Render builds the repository's companion Dockerfile and uses `/readyz` for deployment health.

After Render assigns the service URL, use its HTTPS origin as the n8n companion URL.

## Kubernetes

Publish the companion image first, record the registry-reported SHA-256 digest, and render with cluster-specific inputs:

```bash
node scripts/render-deployments.mjs \
  --kubernetes-image "$CLIENTOPS_COMPANION_IMAGE" \
  --kubernetes-hostname "$CLIENTOPS_COMPANION_HOSTNAME" \
  --kubernetes-ingress-class "$CLIENTOPS_INGRESS_CLASS" \
  --kubernetes-tls-secret "$CLIENTOPS_TLS_SECRET"
```

Create the API Secret outside the repository before applying the manifest:

```bash
kubectl create namespace clientops-relay --dry-run=client --output=yaml | kubectl apply --filename=-
kubectl --namespace clientops-relay create secret generic clientops-relay-companion \
  --from-literal=api-key="$CLIENTOPS_COMPANION_API_KEY" \
  --dry-run=client --output=yaml | kubectl apply --filename=-
kubectl apply --server-side --filename deploy/kubernetes/clientops-relay-companion.json
kubectl --namespace clientops-relay rollout status deployment/clientops-relay-companion
```

The generated Kubernetes List contains a namespace, least-privilege ServiceAccount, two-replica Deployment, ClusterIP Service, TLS Ingress, and PodDisruptionBudget. Startup and readiness use `/readyz`; liveness uses `/healthz`. The Deployment consumes the API key only through `secretKeyRef`.

## n8n Cloud

Import `workflows/cloud/01-api-lead-intake.json` and map these credentials:

- `ClientOps Intake API Key`: HTTP Header Auth with header `X-ClientOps-Intake-Key`.
- `ClientOps Companion API Key`: HTTP Header Auth with header `X-ClientOps-Companion-Key` and the exact key configured on the companion.
- `ClientOps PostgreSQL`: TLS-enabled PostgreSQL access to the initialized ClientOps database as `clientops_app`.

The checked-in workflow reads the public origin from the n8n custom variable `CLIENTOPS_COMPANION_URL`. It rejects a successful HTTP response unless the payload carries policy version `clientops-triage-v1` and the complete bounded decision shape, before the PostgreSQL node can run. If the n8n plan does not provide custom variables, render a workflow containing the concrete public HTTPS origin instead:

```bash
node scripts/render-deployments.mjs --companion-url "$CLIENTOPS_COMPANION_URL"
```

Review the imported credential mappings, execute one authenticated test request, and only then publish the workflow. The generated workflow is inactive on import and stores no successful, failed, manual, or progress execution payloads.

This Cloud artifact is an intake frontend, not a claim that the local stack has been reproduced inside n8n Cloud. It performs validation, calls the real companion policy, enforces the response contract, and transactionally queues work through the existing database function. Delivery, SLA, digest, retention, and error-sink schedules are not duplicated into this one workflow. They must continue to run from a deployed ClientOps worker stack that owns the migrated database, or be imported and adapted separately with real reachable email and notification services. The generated intake intentionally has no dangling `errorWorkflow` dependency.

# ClientOps deployment companion

This service is the narrow credential boundary used when n8n cannot reach the
private policy container directly. It invokes the same compiled C policy engine;
it is not a second rules implementation and it cannot proxy arbitrary URLs.

Build from the repository root:

```sh
docker build --file companion/Dockerfile --tag clientops-companion:local .
```

Required runtime configuration:

| Name | Contract |
| --- | --- |
| `CLIENTOPS_COMPANION_API_KEY` | exactly 64 lowercase hexadecimal characters |
| `PORT` | optional; defaults to `8080` |
| `HOST` | optional; defaults to `0.0.0.0` |

`GET /healthz` is a process-liveness probe. `GET /readyz` executes bounded
version and configuration probes against the real policy binary. Both omit
credentials and request data from their responses.

The only business endpoint is `POST /v2/qualify`. Supply
`X-ClientOps-Companion-Key`, use `Content-Type: application/json`, and send the
same bounded request object accepted by `policy-engine/policy_cli`. Success and
validation rejection preserve the policy engine's JSON and status semantics
(`200` and `422`). Authentication is checked before the request body is read.

The companion deliberately has no general upstream URL, dynamic command,
shell execution, filesystem endpoint, CORS allowance, or request logging.

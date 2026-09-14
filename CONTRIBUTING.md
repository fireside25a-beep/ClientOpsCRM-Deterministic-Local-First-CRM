# Contributing

## Development setup

Install:

- Node.js 22.22 or newer;
- npm;
- a C11 compiler and make;
- the cJSON runtime or development package;
- Docker with Compose for full acceptance.

Then run:

~~~bash
npm ci
node scripts/build-workflows.mjs
npm test
make -C policy-engine sanitize
~~~

Generated workflow JSON must be changed through <code>scripts/build-workflows.mjs</code>. Run the generator before committing and include the resulting JSON.

Policy behavior is configured through <code>policy-engine/config/policy.json</code>. Keep configuration bounded and generic; add deterministic cases for new categories or routing behavior. A database contract change must include both a fresh-schema test and an idempotent upgrade test.

## Pull-request checks

- Keep exact dependency and container pins.
- Add a contract test for behavior changes.
- Preserve separate intake and administrative credentials.
- Do not enable n8n execution payload persistence.
- Do not add inline secrets or decrypted credential exports.
- Keep core acceptance free of paid or personal OAuth accounts.
- State whether an external connector was structurally validated, import-validated, or live-tested.
- Keep the domain-neutrality gate green; historical contract terms belong only in the compatibility migration and upgrade fixture.
- Run <code>./clientops verify</code> for changes that affect Compose or runtime behavior.

## Commit scope

Prefer focused commits with a clear failure mode and verification note. Avoid unrelated formatting churn in generated JSON.

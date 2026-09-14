# LinkedIn post

I built ClientOps Relay 1.2: an n8n system that takes a request from authenticated webhook to deterministic triage, durable storage, customer acknowledgement, owner alert, and SLA follow-up.

The interesting part was deciding what happens when the same webhook arrives twice, a provider is down, a worker crashes mid-delivery, or a ticket gets marked contacted while an alert is already queued.

The result includes:

- 201 create / 200 exact replay / 409 changed-data conflict;
- a compiled C rules engine with 100 byte-identical reruns;
- configurable categories, any-region or allowlist routing, and any IANA timezone;
- a PostgreSQL transactional outbox with leases and fencing tokens;
- real local SMTP and ntfy delivery;
- bounded retries, dead letters, SLA escalation, and retention;
- separate intake/admin credentials and no IP retention;
- seven core n8n workflows imported and published on the pinned 2.37.10 release.
- a real authenticated companion and reproducible Railway, Render, Kubernetes, and n8n Cloud deployment artifacts.

I also included an optional Google Sheets + Slack + Gmail workflow, with the OAuth/live-test boundary documented instead of pretending credentials were available.

This is the kind of automation work I want to do for small businesses: useful on the happy path, but designed for the failure path too.

#n8n #automation #postgresql #javascript #workflowautomation

# GitHub preparation provenance

This repository was prepared from the retained source archive `01_ClientOpsCRM_2.0.0_SOURCE_AIO.zip` inside the user-supplied `ClientOpsCRM_2.0.0_FINAL_MASTER_AIO.zip`.

No CRM or Relay runtime source was rewritten during the GitHub presentation pass.

GitHub-only changes:

- modern local SVG header and architecture graphic;
- README presentation prefix while preserving the original README under `provenance/`;
- documentation index;
- issue and pull-request templates;
- CI split so the compiled CRM core has its own native gate;
- optional portfolio rendering removed from the required CI/release-evidence path;
- provenance and final repository checksum manifest.

The static portfolio assets and retained CRM PDFs are informational. They do not participate in the application build.

Release-audit compatibility fix:

- `crm/build/` is treated as generated build scratch, matching `.gitignore` and the release packager.
- retained `evidence/crm/` files are exempt only from the private-build-path leak rule because they are historical execution evidence and intentionally preserve the paths recorded by the original verification run. They remain subject to the other release-audit checks.

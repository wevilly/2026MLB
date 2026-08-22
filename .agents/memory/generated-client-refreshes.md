---
name: Generated client refreshes
description: Development-server behavior during OpenAPI client regeneration.
---

After running the OpenAPI generator, restart the web Vite workflow before relying on browser logs or HMR state.

**Why:** The generator cleans the generated output directory before recreating it. Vite can observe that brief gap and report missing generated API modules or an HMR reload failure even though generation and typechecking succeed.

**How to apply:** Treat import errors emitted only during the generator run as transient. Confirm generation/typechecking, restart the affected web workflow, then inspect fresh logs and browser behavior.
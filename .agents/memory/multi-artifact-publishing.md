---
name: Multi-artifact publishing
description: Production release coordination for workspaces with separately deployed web and API artifacts.
---

When a product is split across registered artifacts, publish and verify each user-facing service independently; a successful web publish does not imply that the API deployment contains the same build.

**Why:** The web deployment can be live while its separately deployed API still serves the previous contract, causing new UI flows to fail with old-route responses.

**How to apply:** After publishing, call deployment metadata and probe a changed API contract before running production operations. Treat a missing changed route as a release-blocking mismatch, not as an application-data failure.
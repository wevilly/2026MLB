---
name: Model artifact lifecycle
description: Durable storage and activation boundary for the model framework.
---

Model artifacts must be written with a create-only object-generation precondition, and model versions must pin both that generation and a SHA-256 content hash. Readers should verify the pinned generation before use.

**Why:** A database key and hash alone do not prevent object replacement, and a caller-controlled session flag is not evidence of a Phase 5B validation.

**How to apply:** Keep Phase 5A candidates non-active. Phase 5B must introduce a controlled activation procedure that validates a real walk-forward acceptance record rather than trusting a request flag.
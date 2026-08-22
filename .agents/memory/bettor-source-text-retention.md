---
name: Bettor source-text retention
description: Safety rule for persisting bettor-provided reasoning in the intelligence ingestion layer.
---

When a bettor rationale exceeds the bounded retention length, persist a concise structured summary derived from its approved mechanism tags rather than a truncated excerpt of the original text. Mark the original text as not retained.

**Why:** A partial first-sentence copy is still verbatim source content while falsely implying a paraphrase, and can preserve more third-party prose than the evidence register is intended to retain.

**How to apply:** Preserve short, normalized rationales only within the explicit retention bound. For longer inputs, record the mechanism-level context and the retention-limit notice without copying source prose. Keep this behavior consistent in both response mapping and future exports.
---
name: AI tool audit integrity
description: Integrity requirements for the AI Analyst tool-call audit trail.
---

AI tool-call records must be append-only at the database boundary for every environment. Do not introduce a session setting, application flag, or maintenance bypass that lets the running application update, delete, or truncate audit history. Tests must use distinct correlation identifiers and retain their audit rows.

**Why:** A generic database-session bypass is available to any code using the application role, so it makes an ostensibly immutable audit trail erasable precisely where it needs to be trustworthy.

**How to apply:** Keep tool logs immutable across update, delete, and truncate operations. Store caller session values only as correlation data, alongside a server-generated request identity and the tool definition captured at execution time.
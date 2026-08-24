---
name: Post-merge database hook
description: Non-interactive behavior of the development database post-merge hook.
---

The `db` package selector resolves to the scoped database workspace; it is not silently skipped. However, treat the post-merge database hook as failed unless its full command exits cleanly and verify live metadata afterward.

**Why:** When Drizzle detects a schema conflict in a non-TTY shell, it cannot render its required prompt. Its failure output can still be followed by the subsequent immutability step, leaving some database operations applied before the overall hook exits nonzero.

**How to apply:** Before relying on a merge as runtime-ready, run the hook non-interactively, require exit code 0, and query the newly declared tables, columns, indexes, and enum labels directly. Resolve the underlying schema conflict rather than assuming the scoped package filter is the cause.
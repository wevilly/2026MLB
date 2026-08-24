#!/bin/bash
#
# Replit postMerge hook. Runs on every merge, unattended, with no TTY.
#
# Its whole job is to bring the database up to the merged schema. That means it
# has to fail in a way a human can act on later, because nobody is watching it
# run.
#
# The push chain is, in order:
#   1. lib/db/scripts/pre-push-migrations.mjs   explicit DDL push cannot express
#   2. drizzle-kit push                         the additive remainder
#   3. lib/db/scripts/apply-immutability.mjs    append-only triggers and guards
#
set -euo pipefail

# ── DATABASE_URL ────────────────────────────────────────────────────────────
#
# Guarded here rather than left to drizzle. Without it the failure surfaces as
# a drizzle config error thrown from inside a config file, which reads like a
# broken repository rather than an unprovisioned database.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "post-merge: DATABASE_URL is not set." >&2
  echo "post-merge: the database is not provisioned for this environment, so the" >&2
  echo "            schema cannot be pushed. Provision it, then re-run:" >&2
  echo "              pnpm --filter @workspace/db run push" >&2
  exit 1
fi

pnpm install --frozen-lockfile

# ── the push ────────────────────────────────────────────────────────────────
#
# Full package name, not the short 'db' filter. The short form does resolve
# today, but it is implicit and one rename away from matching nothing at all,
# which pnpm reports as success.
#
# The output is teed rather than streamed straight through, because of the
# failure mode handled below.
# ── capture what the push is about to destroy ───────────────────────────────
#
# M6 in pre-push-migrations.mjs normalises the stored empty strings in
# players.bats and players.throws to NULL, which is irreversible. The
# data-health counters count null and empty together, so the combined figure
# survives; the split does not, and the split is the only evidence separating
# handedness the S1 bug destroyed from handedness that was never collected.
#
# Recorded here rather than left to a remembered manual step, because this is
# the run that destroys it. Best effort: a merge must not fail over a census.
# Only the FIRST capture carries information. M6 runs below, and every run after
# it records empty 0 by construction, so a file of zeros means the census ran
# late, not that nothing was damaged. Appended to reports/handedness-census.jsonl,
# which is committed: a merge log is ephemeral and this measurement is one-shot.
echo "post-merge: recording the handedness census before it is normalised away."
if node lib/db/scripts/handedness-census.mjs; then
  echo "post-merge: census appended to reports/handedness-census.jsonl. COMMIT IT."
else
  echo "post-merge: CENSUS FAILED, continuing so the merge is not blocked." >&2
  echo "            The empty-versus-null split is unrecoverable once the push" >&2
  echo "            below runs M6. If this was the first run on this database," >&2
  echo "            that measurement is now lost." >&2
fi

push_log="$(mktemp)"
trap 'rm -f "$push_log"' EXIT

set +e
pnpm --filter @workspace/db run push 2>&1 | tee "$push_log"
push_status="${PIPESTATUS[0]}"
set -e

# ── the TTY prompt ──────────────────────────────────────────────────────────
#
# drizzle-kit push EXITS 0 when it dies on an interactive prompt. Verified
# against drizzle-kit 0.31.10: the error is printed, nothing is applied, and
# the process still reports success. set -e cannot catch that, and neither can
# checking the exit status, so the log is matched explicitly.
#
# Left undetected, the chain runs on to apply-immutability, which then fails on
# whatever object push did not create, and the merge log shows a trigger error
# that has nothing to do with the actual cause.
if grep -qE 'Interactive prompts require a TTY|promptColumnsConflicts' "$push_log"; then
  echo "" >&2
  echo "post-merge: drizzle-kit push hit an interactive prompt and applied NOTHING." >&2
  echo "" >&2
  echo "  This happens when push sees a column dropped and a column added on the" >&2
  echo "  same table in one diff and cannot tell a rename from a create-plus-drop." >&2
  echo "  There is no human here to answer it, so it aborts the entire diff." >&2
  echo "" >&2
  echo "  Fix it by writing the change as explicit, idempotent DDL in:" >&2
  echo "    lib/db/scripts/pre-push-migrations.mjs" >&2
  echo "" >&2
  echo "  Do NOT resolve it with push --force. Force accepts drizzle's guess about" >&2
  echo "  which column was renamed, and it will make that guess against tables of" >&2
  echo "  settled outcomes and model metrics." >&2
  echo "" >&2
  exit 1
fi

if [ "$push_status" -ne 0 ]; then
  echo "post-merge: schema push failed with exit ${push_status}. See the log above." >&2
  exit "$push_status"
fi

echo "post-merge: schema is up to date."

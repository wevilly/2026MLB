# Repository inventory

Remediation task 5.4. What is in this repository, whether it belongs, and what
was done about it.

## Build output

A clean clone contains no build output. `.gitignore` already covers `dist`,
`*.tsbuildinfo`, `out-tsc` and `node_modules`, and `git ls-files` confirms none
of those paths are tracked. `lib/db/dist` and similar directories exist on disk
after a build and are correctly ignored.

No change was needed.

## Root-level scripts

Both root-level scripts were one-off codemods that rewrote
`artifacts/mlb-analyst/src/App.tsx` by exact string replacement:

| Script | What it was | Disposition |
| --- | --- | --- |
| `modify_app.py` | Added research lab imports and pages to App.tsx | Deleted. Dead. |
| `patch_app.js` | Inserted the Bettor Intelligence page into App.tsx | Deleted. Dead. |

Neither is re-runnable: each matches literal strings in a file that has changed
substantially since, so re-running them would either fail silently or corrupt
the file. Their edits landed long ago and are part of the file's history. They
were deleted rather than moved under `scripts/`, because a script that cannot be
run again is not a migration script, it is a record, and git already holds the
record.

The repository root now has no loose scripts. Everything executable lives under
`scripts/` or `lib/db/scripts/`, each with a header comment stating its purpose.

## Working material

Three directories hold material that is not an input to the build:

| Directory | Contents | Tracked files |
| --- | --- | --- |
| `attached_assets/` | Planning documents, roadmaps, screenshots, one zip | 60 |
| `screenshots/` | Acceptance screenshots from earlier phases | 29 |
| `reports/` | One progress report, .docx | 1 |

`artifacts/mlb-analyst/vite.config.ts` declares an `@assets` alias pointing at
`attached_assets/`, but nothing imports through it, so the directory is not a
build input in practice either.

These were NOT deleted. They are the operator's material, they are recoverable
from history either way, and removing 90 tracked files is a decision for the
person whose material it is rather than for a remediation pass. What was done
instead:

- All three are now listed in `.replitignore`, so they are excluded from
  deployed images, which is what that file is for.
- This note records the assessment.

**Recommendation:** move `attached_assets/`, `screenshots/` and `reports/` out
of version control. Planning documents and acceptance screenshots are better
held wherever the rest of the project's documents live; the repository should
carry the code, the schema, the contract and the runbooks. If they stay, the
`@assets` alias in `vite.config.ts` should either be used or removed, because a
declared-and-unused alias reads as a build dependency that is not one.

## Ignore files

- `.gitignore` reflects the intended set: build output, dependencies, editor
  files, caches. No change needed.
- `.replitignore` previously excluded only `.local`. It now also excludes the
  three working-material directories and `tests/`, none of which belong in a
  deployed image.

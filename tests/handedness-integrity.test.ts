/**
 * Audit S1 and S12.
 *
 * players.throws was overwritten with an empty string by the game-feed player
 * upsert, and the conflict clause was unconditional, so any call whose payload
 * lacked pitchHand destroyed a known handedness. Downstream, an empty string is
 * not null: resolveBatterSide returns null for a switch hitter,
 * isPlatoonDisfavored returns false, and every split metric quietly resolves to
 * the unsplit season line with nothing reporting it.
 *
 * That undermines everything Phase 4 added, because park and weather now sit on
 * top of a platoon layer that may not be running at all.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { bundleService } from "./helpers/bundle.ts";

const dataFoundation = bundleService("artifacts/api-server/src/services/data-foundation.ts");

const source = (path: string) => readFileSync(path, "utf8");
const DATA_FOUNDATION = source("artifacts/api-server/src/services/data-foundation.ts");
const ENGINES = ["tb", "xbh", "walk", "hr"] as const;

describe("S1 part 2 - unknown handedness is NULL, never an empty string", () => {
  test("the three real MLB codes survive, in any casing or padding", async () => {
    const { handednessCode } = await dataFoundation as {
      handednessCode: (value: unknown) => string | null;
    };
    for (const code of ["L", "R", "S"]) {
      assert.equal(handednessCode(code), code);
      assert.equal(handednessCode(code.toLowerCase()), code);
      assert.equal(handednessCode(`  ${code} `), code);
    }
  });

  test("absent, blank and unrecognised values all become null, not an empty string", async () => {
    const { handednessCode } = await dataFoundation as {
      handednessCode: (value: unknown) => string | null;
    };
    // The empty string is the specific value the bug wrote. It must never be a
    // possible return: null is what makes unknown distinguishable from known.
    for (const value of ["", "   ", "\t", undefined, null, {}, [], "X", "LR", true]) {
      assert.equal(
        handednessCode(value), null,
        `handednessCode(${JSON.stringify(value)}) must be null, never an empty string`,
      );
    }
  });
});

describe("S1 part 1 - neither player upsert can erase a known handedness", () => {
  test("both upserts guard bats and throws on a non-empty excluded value", () => {
    // Same guard bullpen-foundation already uses for reliever_profiles.throws.
    for (const column of ["bats", "throws"]) {
      const guard = new RegExp(
        `${column}\\s*=\\s*CASE\\s*WHEN EXCLUDED\\.${column} IS NOT NULL AND EXCLUDED\\.${column} <> ''`,
        "g",
      );
      const matches = DATA_FOUNDATION.match(guard) ?? [];
      assert.equal(
        matches.length, 2,
        `expected the non-empty guard on ${column} in BOTH player upserts, found ${matches.length}`,
      );
    }
  });

  test("no player upsert assigns handedness unconditionally from EXCLUDED", () => {
    for (const column of ["bats", "throws"]) {
      const unconditional = new RegExp(`${column} = EXCLUDED\\.${column}(?!\\w)`, "g");
      assert.equal(
        (DATA_FOUNDATION.match(unconditional) ?? []).length, 0,
        `${column} = EXCLUDED.${column} is the unconditional clause that destroyed known handedness`,
      );
    }
  });

  test("handedness is never written through String(... ?? \"\")", () => {
    for (const field of ["batSide.code", "pitchHand.code", "metadata.bat_hand", "metadata.throw_hand"]) {
      assert.ok(
        !DATA_FOUNDATION.includes(`String(${field} ?? "")`),
        `${field} must go through handednessCode, not String(... ?? "")`,
      );
    }
  });
});

describe("S12 - an unresolved platoon side is disclosed, and never as a blocking gap", () => {
  for (const engine of ENGINES) {
    const path = `artifacts/api-server/src/services/${engine}-engine.ts`;

    test(`${engine}-engine emits PLATOON_SIDE_UNRESOLVED as counter evidence`, () => {
      const text = source(path);
      assert.ok(
        /counters\.push\("PLATOON_SIDE_UNRESOLVED"\)/.test(text),
        `${engine}-engine must push PLATOON_SIDE_UNRESOLVED onto counter evidence`,
      );
    });

    test(`${engine}-engine keeps the disclosure out of missing_stale_evidence`, () => {
      const text = source(path);
      // missing_stale_evidence is a blocking gate: anything written there makes
      // the candidate non-selectable. An unknown handedness is a caveat on the
      // reading, not a veto on the candidate. This is the same back door the
      // bullpen veto used before task 3.4 caught it.
      assert.ok(
        !/missingData\.push\([^)]*PLATOON_SIDE_UNRESOLVED/.test(text),
        `${engine}-engine must not write PLATOON_SIDE_UNRESOLVED into missing_stale_evidence`,
      );
    });
  }
});

describe("S1 part 4 - the stored empty strings are retired and re-hydratable", () => {
  const migrations = source("lib/db/scripts/pre-push-migrations.mjs");
  const backfill = source("lib/db/scripts/backfill-handedness.mjs");

  test("the migration normalises '' to NULL for both columns", () => {
    for (const column of ["bats", "throws"]) {
      assert.ok(
        migrations.includes(`UPDATE players SET ${column} = NULL WHERE ${column} IS NOT NULL AND btrim(${column}) = ''`),
        `pre-push-migrations must retire the stored empty strings in players.${column}`,
      );
    }
  });

  test("the backfill only ever fills a gap, never restates over a known value", () => {
    // COALESCE on the stored side is what makes a re-run safe: a handedness
    // already recorded is preserved even if the feed disagrees.
    assert.ok(backfill.includes("COALESCE(NULLIF(btrim(throws), ''), $2)"), "throws must be filled, not overwritten");
    assert.ok(backfill.includes("COALESCE(NULLIF(btrim(bats),   ''), $3)"), "bats must be filled, not overwritten");
  });
});

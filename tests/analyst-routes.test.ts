/**
 * Task 5.2 acceptance.
 *
 * routes/analyst.ts was 2,405 lines and 70 routes in one file. It exceeded the
 * read limit of standard tooling, could not be read during the audit, and was
 * therefore the largest unreviewed surface in the application.
 *
 * The split had to be a pure move: same URLs, same handlers, no behaviour
 * change. These assertions are what "pure move" means, mechanically.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const ROUTES_DIR = "artifacts/api-server/src/routes/analyst";
const INVENTORY = `${ROUTES_DIR}/ROUTE-INVENTORY.txt`;

/** The bar the plan sets: every module must be readable by standard tooling. */
const READ_LIMIT_LINES = 2000;

function moduleFiles() {
  return readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${ROUTES_DIR}/${name}`);
}

function registeredRoutes(): string[] {
  const routes: string[] = [];
  for (const file of moduleFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^router\.(get|post|put|patch|delete)\("([^"]+)"/gm)) {
      routes.push(`${match[1].toUpperCase().padEnd(6)}  ${match[2]}`);
    }
  }
  return routes;
}

function pinnedRoutes(): string[] {
  return readFileSync(INVENTORY, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [verb, ...rest] = line.trim().split(/\s+/);
      return `${verb.padEnd(6)}  ${rest.join(" ")}`;
    });
}

describe("Task 5.2 the route inventory is unchanged", () => {
  test("every pinned route is still registered, and nothing new appeared", () => {
    const before = pinnedRoutes().slice().sort();
    const after = registeredRoutes().slice().sort();
    assert.deepEqual(after, before, "the URL surface must be identical after the split");
  });

  test("no route is registered twice", () => {
    const routes = registeredRoutes();
    const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
    assert.deepEqual(duplicates, [], "a route registered in two modules would shadow itself");
  });

  test("every route path is absolute, so mounting cannot change a URL", () => {
    for (const route of registeredRoutes()) {
      assert.ok(route.includes("  /analyst/"), `${route} is not an absolute analyst path`);
    }
  });
});

describe("Task 5.2 every module is readable", () => {
  test("no module exceeds the tooling read limit", () => {
    for (const file of [...moduleFiles(), "artifacts/api-server/src/routes/analyst.ts"]) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      assert.ok(lines <= READ_LIMIT_LINES, `${file} is ${lines} lines, over the ${READ_LIMIT_LINES} limit`);
    }
  });

  test("the index only mounts, it does not register", () => {
    const index = readFileSync("artifacts/api-server/src/routes/analyst.ts", "utf8");
    assert.ok(!/^router\.(get|post|put|patch|delete)\(/m.test(index), "the index must register no routes itself");
    assert.equal((index.match(/^router\.use\(/gm) ?? []).length, moduleFiles().length - 1, "every domain module must be mounted");
  });
});

describe("Task 5.2 a parameterised path never shadows a literal sibling", () => {
  test("the settlement literals are registered before the parameterised path", () => {
    const source = readFileSync(`${ROUTES_DIR}/settlement.ts`, "utf8");
    const parameterised = source.indexOf('router.post("/analyst/settlements/:gamePk"');
    assert.ok(parameterised > 0, "the parameterised settlement route must exist");
    for (const literal of ["/analyst/settlements/automate", "/analyst/settlements/ingest"]) {
      const at = source.indexOf(`router.post("${literal}"`);
      assert.ok(at > 0, `${literal} must exist`);
      assert.ok(at < parameterised, `${literal} must be registered before /analyst/settlements/:gamePk`);
    }
  });

  test("no parameterised route can shadow a literal sibling across modules", () => {
    // Express matches in registration order. A parameterised path only shadows
    // a literal with the SAME segment count under the same prefix, so this
    // checks that any such pair lives in one module, where relative order is
    // preserved by the split.
    const byModule = new Map<string, string[]>();
    for (const file of moduleFiles()) {
      const source = readFileSync(file, "utf8");
      byModule.set(file, [...source.matchAll(/^router\.(get|post|put|patch|delete)\("([^"]+)"/gm)]
        .map((match) => `${match[1].toUpperCase()} ${match[2]}`));
    }
    const all = [...byModule.entries()].flatMap(([file, routes]) => routes.map((route) => ({ file, route })));
    const parameterised = all.filter((entry) => entry.route.includes("/:"));
    for (const entry of parameterised) {
      const [verb, path] = entry.route.split(" ");
      const segments = path.split("/");
      const paramIndex = segments.findIndex((segment) => segment.startsWith(":"));
      const prefix = segments.slice(0, paramIndex).join("/");
      for (const other of all) {
        const [otherVerb, otherPath] = other.route.split(" ");
        if (otherVerb !== verb || otherPath === path) continue;
        const otherSegments = otherPath.split("/");
        const sameShape = otherSegments.length === segments.length
          && otherSegments.slice(0, paramIndex).join("/") === prefix
          && !otherSegments[paramIndex].startsWith(":");
        if (!sameShape) continue;
        assert.equal(
          other.file, entry.file,
          `${other.route} would be shadowed by ${entry.route} and they are in different modules`,
        );
      }
    }
  });
});

describe("Task 5.2 the operator-session pair is documented, not collapsed", () => {
  test("both surfaces survive and each says why the other exists", () => {
    const ai = readFileSync(`${ROUTES_DIR}/ai.ts`, "utf8");
    const operations = readFileSync(`${ROUTES_DIR}/orchestration.ts`, "utf8");
    assert.ok(ai.includes('router.post("/analyst/ai/operator-session"'));
    assert.ok(operations.includes('router.post("/analyst/operations/operator-session"'));
    // They are NOT the same endpoint: different cookie namespaces.
    assert.ok(ai.includes("ai_operator_approval"));
    assert.ok(operations.includes("operations_operator_approval"));
    assert.ok(/NOT a duplicate/.test(ai), "the AI route must state why the pair exists");
    assert.ok(/NOT a duplicate/.test(operations), "the operations route must state the same");
  });
});

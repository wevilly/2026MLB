import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8080/api";
const reportPath = resolve(process.env.ACCEPTANCE_REPORT_PATH ?? "docs/final-acceptance-report.md");
const startedAt = new Date();

function execute(label, command, args) {
  const started = Date.now();
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
    child.on("error", (error) => resolveCommand({ label, status: "FAIL", durationMs: Date.now() - started, output: String(error) }));
    child.on("close", (code) => resolveCommand({
      label,
      status: code === 0 ? "PASS" : "FAIL",
      durationMs: Date.now() - started,
      output,
    }));
  });
}

function statusRow(result) {
  return `| ${result.label} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s |`;
}

function failureDetail(result) {
  if (result.status === "PASS") return "";
  const detail = result.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(" ")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted connection string]");
  return `- **${result.label}:** ${detail || "No diagnostic output was captured."}`;
}

const checks = [];
try {
  const response = await fetch(`${apiBaseUrl}/healthz`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  checks.push({ label: "Live API health", status: "PASS", durationMs: 0, output: "" });
} catch (error) {
  checks.push({ label: "Live API health", status: "FAIL", durationMs: 0, output: error instanceof Error ? error.message : String(error) });
}

if (checks[0].status === "PASS") {
  checks.push(await execute("Phase 2A live report", "pnpm", ["report:phase-2a"]));
  checks.push(await execute("All phase behavioral gates", "pnpm", ["test:all"]));
  checks.push(await execute("Warm read-performance SLA", "pnpm", ["test:load"]));
} else {
  checks.push({ label: "Phase 2A live report", status: "SKIP", durationMs: 0, output: "API health failed." });
  checks.push({ label: "All phase behavioral gates", status: "SKIP", durationMs: 0, output: "API health failed." });
  checks.push({ label: "Warm read-performance SLA", status: "SKIP", durationMs: 0, output: "API health failed." });
}

if (process.env.RESTORE_DATABASE_URL) {
  checks.push(await execute("Isolated restore lineage drill", "pnpm", ["verify:restore-drill"]));
} else {
  checks.push({
    label: "Isolated restore lineage drill",
    status: "PENDING",
    durationMs: 0,
    output: "Set RESTORE_DATABASE_URL to an isolated restored database; the verifier rejects the active DATABASE_URL.",
  });
}

const phaseStatus = checks.find((check) => check.label === "All phase behavioral gates")?.status === "PASS" ? "PASS" : "NOT PASSED";
const securityStatus = process.env.SECURITY_SCAN_STATUS ?? "RECORDED SEPARATELY";
const blockingFailure = checks.some((check) => check.status === "FAIL");
const restorePending = checks.some((check) => check.label === "Isolated restore lineage drill" && check.status === "PENDING");
const overallStatus = blockingFailure ? "FAIL" : restorePending ? "CONDITIONAL PASS — RESTORE DRILL PENDING" : phaseStatus;
const report = `# Final acceptance report

Generated: ${startedAt.toISOString()}  
API target: ${apiBaseUrl}  
Overall automated gate: **${overallStatus}**

## Operational checks

| Check | Result | Duration |
|---|---:|---:|
${checks.map(statusRow).join("\n")}

Security scan status: **${securityStatus}**. Security scanning is run through the workspace security scanner and is recorded alongside this report rather than by this script.

## Phase-gate coverage

| Gate | Result | Evidence |
|---|---:|---|
| 2A identity and research foundation | ${phaseStatus} | ` + "`test:all`, `report:phase-2a`" + ` |
| 2B bullpen availability | ${phaseStatus} | ` + "`test:all`" + ` |
| 3 / 3A–3D four independent research engines | ${phaseStatus} | ` + "`test:all`" + ` |
| 4A feature integrity / 4B official settlement | ${phaseStatus} | ` + "`test:all`" + ` |
| 5A model artifacts / 5B walk-forward validation | ${phaseStatus} | ` + "`test:all`" + ` |
| 6 confidence board | ${phaseStatus} | ` + "`test:all`" + ` |
| 7A–7B bettor lineage and evaluation | ${phaseStatus} | ` + "`test:all`" + ` |
| 8A–8B AI constraints and human review | ${phaseStatus} | ` + "`test:all`" + ` |
| 9A orchestration / 9B settlement and exports | ${phaseStatus} | ` + "`test:all`" + ` |
| 10 hardening, cache, audit, restore contract | ${phaseStatus} | ` + "`test:all`, `test:load`, restore drill row above" + ` |

## Acceptance interpretation

The aggregate behavioral suite is the authoritative phase gate because it runs every existing phase acceptance test against the configured live database and API. A **PENDING** isolated restore drill is not treated as a pass: complete it only against a populated, non-production restored database and retain the output with this report. See the operator runbook for operational procedures and known limitations.

## Failure or pending details

${checks.filter((check) => check.status !== "PASS").map(failureDetail).join("\n") || "None."}
`;

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, report);
console.log(`\nWrote final acceptance report: ${reportPath}`);
if (blockingFailure || restorePending) {
  console.error("Final acceptance is not complete: resolve failed checks and run the isolated restore lineage drill.");
  process.exitCode = 1;
}
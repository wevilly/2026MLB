export function validateRestoreSummary(summary) {
  const requiredCounts = [
    ["orchestrationRuns", summary.orchestrationRuns],
    ["pregameFeatureSnapshots", summary.pregameFeatureSnapshots],
    ["historicalOutcomes", summary.historicalOutcomes],
    ["marketPostmortems", summary.marketPostmortems],
    ["auditEvents", summary.auditEvents],
  ];
  const empty = requiredCounts.filter(([, count]) => !Number.isInteger(count) || count <= 0).map(([name]) => name);
  if (empty.length) {
    throw new Error(`Restore validation failed; required records are empty: ${empty.join(", ")}`);
  }
  if (summary.snapshotsWithOutcome <= 0 || summary.linkedPostmortems !== summary.marketPostmortems) {
    throw new Error("Restore validation failed; frozen snapshots, official outcomes, and postmortems are not fully linked.");
  }
  return summary;
}
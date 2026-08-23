export type MarketResearchSelectionBlockReason =
  | "BLOCKED"
  | "NEGATIVE"
  | "STALE"
  | "UNRESOLVED_IDENTITY"
  | "INCOMPLETE_EVIDENCE";

export type MarketResearchSelectionInput = {
  researchState: string;
  missingStaleEvidence: string | null;
  identityResolved: boolean;
};

export type MarketResearchSelectionEligibility =
  | { selectable: true; selectionBlockReason: null }
  | { selectable: false; selectionBlockReason: MarketResearchSelectionBlockReason };

function hasMissingOrStaleEvidence(value: string | null) {
  return Boolean(value?.trim());
}

/**
 * Determines whether a market-research row can be used as a Round Robin leg.
 * Rows that fail remain visible in research views for audit.
 */
export function getMarketResearchSelectionEligibility(
  candidate: MarketResearchSelectionInput,
): MarketResearchSelectionEligibility {
  if (!candidate.identityResolved) {
    return { selectable: false, selectionBlockReason: "UNRESOLVED_IDENTITY" };
  }

  if (candidate.researchState === "BLOCKED") {
    return { selectable: false, selectionBlockReason: "BLOCKED" };
  }

  if (candidate.researchState === "NEGATIVE") {
    return { selectable: false, selectionBlockReason: "NEGATIVE" };
  }

  if (hasMissingOrStaleEvidence(candidate.missingStaleEvidence)) {
    return {
      selectable: false,
      selectionBlockReason: /\bstale\b/i.test(candidate.missingStaleEvidence ?? "")
        ? "STALE"
        : "INCOMPLETE_EVIDENCE",
    };
  }

  return { selectable: true, selectionBlockReason: null };
}

export function isSelectableMarketResearchCandidate(candidate: MarketResearchSelectionInput) {
  return getMarketResearchSelectionEligibility(candidate).selectable;
}
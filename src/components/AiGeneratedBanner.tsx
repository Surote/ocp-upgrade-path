/**
 * A persistent, non-dismissible note that this tool's recommendations are
 * AI-generated. Deliberately not a toast: no close button and no state, so
 * the caveat is in view on every query, not just the first. The copy
 * separates what is pulled live from Red Hat (the graph) from what is this
 * tool's own work (path choice, risk weighting, guidance); MethodExplainer
 * has the fuller version.
 */
export function AiGeneratedBanner() {
  return (
    <p className="ai-note" role="note">
      <strong>AI-generated.</strong> Graph data is live from Red Hat; the recommended path, risk weighting and guidance are
      this tool's own. Verify with Red Hat docs before acting.
    </p>
  );
}

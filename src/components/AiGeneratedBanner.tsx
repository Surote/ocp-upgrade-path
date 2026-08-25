/**
 * A persistent, non-dismissible notice that this tool -- its selection logic,
 * risk weighting and every piece of guidance it shows -- is AI-generated, and
 * must be checked against Red Hat's own documentation before anyone acts on
 * it. Requested directly by the user, not from plan.md.
 *
 * Deliberately not a toast: no close button, no auto-hide, no local state at
 * all. It renders unconditionally as the first thing in `<main>` (App.tsx),
 * so it sits above the fold on every load rather than being something a user
 * can dismiss once and never see the caveat again on a later, different
 * query.
 *
 * The copy is specific rather than generic boilerplate: it distinguishes what
 * *is* pulled live from Red Hat (the graph itself) from what is this tool's
 * own work product (which path gets recommended, how risk is weighted, the
 * admin-acks and EUS/Control-Plane-Only guidance) -- see MethodExplainer for
 * the fuller version of the same distinction.
 */
export function AiGeneratedBanner() {
  return (
    <div className="ai-banner" role="note">
      <span className="ai-banner__badge" aria-hidden="true">
        AI
      </span>
      <p>
        <strong>This tool is AI-generated,</strong> and so are its recommendations. The release graph itself comes straight
        from Red Hat's live Cincinnati API — but which path gets recommended, how risk is weighed, and every piece of
        guidance below (admin-acks, EUS/Control-Plane-Only) is this tool's own work, not Red Hat's. Verify against Red Hat's
        own documentation before acting on any of it.
      </p>
    </div>
  );
}

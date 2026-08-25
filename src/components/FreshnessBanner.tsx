import type { FreshnessViewModel } from '../planner/usePlanner';

/**
 * "Graph fetched at HH:MM" plus a manual refresh, per plan.md §3 -- exists so
 * nobody plans a production upgrade against a stale cached graph without
 * knowing it. `null` (renders nothing) until a graph has actually loaded.
 */
export function FreshnessBanner({ model }: { readonly model: FreshnessViewModel | undefined }) {
  if (!model) return null;
  const time = new Date(model.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <p className="freshness">
      Graph fetched at {time}.{' '}
      <button type="button" onClick={model.onRefresh}>
        Refresh
      </button>
    </p>
  );
}

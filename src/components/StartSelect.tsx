import type { StartFieldViewModel } from '../planner/usePlanner';

/**
 * The start-version dropdown. Sourced from the selected channel's own graph
 * (Phase 3's deliberate scope limitation -- see the implementation report:
 * this under-serves a multi-channel stitch where the true start version
 * isn't a member of the target's channel at all).
 */
export function StartSelect({ id, model }: { readonly id: string; readonly model: StartFieldViewModel }) {
  return (
    <div className="field" aria-busy={model.loading}>
      <label htmlFor={id}>Start version</label>
      <select id={id} value={model.value} disabled={model.disabled || model.loading} onChange={(e) => model.onChange(e.target.value)}>
        <option value="">Select a start version…</option>
        {model.options.map((version) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
      {model.loading && <span>Loading versions…</span>}
      {model.error && (
        <p role="alert" className="field-error">
          {model.error}{' '}
          <button type="button" onClick={model.onRetry}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

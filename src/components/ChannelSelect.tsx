import type { ChannelFieldViewModel } from '../planner/usePlanner';

/**
 * The channel dropdown. Its options come from seed-and-expand discovery
 * (plan.md Q6/Q7) -- there is no endpoint that lists channels up front, so
 * this list can genuinely be empty for a moment while the seed channel is
 * still loading, hence `aria-busy` on the field itself rather than a global
 * spinner (plan.md §6 / Q30).
 */
export function ChannelSelect({ id, model }: { readonly id: string; readonly model: ChannelFieldViewModel }) {
  return (
    <div className="field" aria-busy={model.loading}>
      <label htmlFor={id}>Channel</label>
      <select id={id} value={model.value} disabled={model.loading} onChange={(e) => model.onChange(e.target.value)}>
        <option value="">Select a channel…</option>
        {model.options.map((channel) => (
          <option key={channel} value={channel}>
            {channel}
          </option>
        ))}
      </select>
      {model.loading && <span>Loading channels…</span>}
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

import type { TargetFieldViewModel } from '../planner/usePlanner';

/**
 * The target-version dropdown. Per plan.md §6, unreachable releases are
 * *disabled with the reason attached*, not omitted from the list. The reason
 * is put directly in the `<option>`'s text content (not just a `title`
 * attribute or styling) so it reaches a screen reader the same way it
 * reaches a sighted user.
 *
 * Per plan.md §6 "Look-ahead targets (bidirectional stitching)", selecting a
 * channel doesn't cap the targets on offer at that channel's own graph:
 * `model.lookaheadOptions` names versions discovered in channels *beyond*
 * the selected one, and they're rendered in a visibly distinct `<optgroup>`
 * -- never silently mixed into the in-channel list above it -- so the
 * operator knows before choosing that picking one means a real channel
 * change, not just an in-place `--to` upgrade. A same-class -> `stable`
 * class fallback (an `eus` anchor reaching an odd EUS minor) is called out
 * per option too, since that changes support posture and must never be a
 * silent detail (requirement 5).
 */
export function TargetSelect({ id, model }: { readonly id: string; readonly model: TargetFieldViewModel }) {
  return (
    <div className="field" aria-busy={model.lookaheadLoading}>
      <label htmlFor={id}>Target version</label>
      <select id={id} value={model.value} disabled={model.disabled} onChange={(e) => model.onChange(e.target.value)}>
        <option value="">Select a target version…</option>
        {model.options.length > 0 && (
          <optgroup label="This channel">
            {model.options.map((option) => (
              <option key={option.version} value={option.version} disabled={option.disabled}>
                {option.version}
                {option.disabled ? ` (unavailable — ${option.reason})` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {model.lookaheadOptions.length > 0 && (
          <optgroup label="Beyond this channel — requires a channel change">
            {model.lookaheadOptions.map((option) => (
              <option key={option.version} value={option.version} disabled={option.disabled}>
                {option.version} — via {option.viaChannel}
                {option.classFallback ? ' (drops to stable)' : ''}
                {option.disabled ? ` (unavailable — ${option.reason})` : ''}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {model.lookaheadLoading && <span className="text-muted">Looking further ahead…</span>}
    </div>
  );
}

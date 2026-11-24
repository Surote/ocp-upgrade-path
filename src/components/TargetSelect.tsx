import type { TargetOption } from '../planner/targetOptions';
import type { TargetFieldViewModel } from '../planner/usePlanner';

/**
 * Unreachable targets stay listed but disabled (plan.md §6), with the reason
 * in the option text so a screen reader hears it too. A look-ahead target
 * names its channel inline: picking it means a channel change, and a class
 * fallback changes support posture, so neither may be silent (requirement 5).
 */
function optionLabel(option: TargetOption): string {
  const via = option.via ? ` · via ${option.via.channel}${option.via.classFallback ? ' (class change)' : ''}` : '';
  return `${option.version}${via}${option.reachable ? '' : ' (not reachable)'}`;
}

export function TargetSelect({ id, model }: { readonly id: string; readonly model: TargetFieldViewModel }) {
  return (
    <div className="field" aria-busy={model.lookaheadLoading}>
      <label htmlFor={id}>Target version</label>
      <select id={id} value={model.value} disabled={model.disabled} onChange={(e) => model.onChange(e.target.value)}>
        <option value="">Select a target version…</option>
        {model.groups.map((group) => (
          <optgroup key={group.stream} label={group.stream}>
            {group.options.map((option) => (
              <option key={option.version} value={option.version} disabled={!option.reachable}>
                {optionLabel(option)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {model.lookaheadLoading && <span className="text-muted">Looking further ahead…</span>}
    </div>
  );
}

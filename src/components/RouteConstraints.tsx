import type { StopOption } from '../engine/routeConstraints';
import type { RouteConstraintsViewModel, StopFieldViewModel } from '../planner/usePlanner';

/**
 * "Reachable on", not "via": the planned route can arrive on another channel
 * of equal rank, and naming that one exactly would take a route search per
 * option (1.7 s for the 365 options of eus-4.18 4.16.33 → 5.0.1).
 */
function optionLabel(option: StopOption, selectedChannel: string): string {
  return option.channel === selectedChannel ? option.version : `${option.version} · reachable on ${option.channel}`;
}

function StopField({ index, model, selectedChannel }: { readonly index: number; readonly model: StopFieldViewModel; readonly selectedChannel: string }) {
  const id = `stop-${index}`;
  const errorId = `${id}-error`;
  const offered = model.groups.some((g) => g.options.some((o) => o.version === model.value));
  return (
    <li className="stop-field">
      <label htmlFor={id}>Stop {index + 1}</label>
      <div className="stop-field__row">
        <select
          id={id}
          value={model.value}
          aria-invalid={model.error ? true : undefined}
          aria-describedby={model.error ? errorId : undefined}
          onChange={(e) => model.onChange(e.target.value)}
        >
          <option value="">Select a stop…</option>
          {model.value && !offered && <option value={model.value}>{model.value} (not offered)</option>}
          {model.groups.map((group) => (
            <optgroup key={group.stream} label={group.stream}>
              {group.options.map((option) => (
                <option key={option.version} value={option.version}>
                  {optionLabel(option, selectedChannel)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="stop-field__remove" aria-label={`Remove stop ${index + 1}`} onClick={model.onRemove}>
          ×
        </button>
      </div>
      {model.error && (
        <p id={errorId} role="alert" className="field-error">
          {model.error}
        </p>
      )}
    </li>
  );
}

/**
 * Operator-pinned stops and the risk policy: one compact row under the
 * selection rail. Stops stay in route order; each one's options already
 * honor its neighbours.
 */
export function RouteConstraints({ model, selectedChannel }: { readonly model: RouteConstraintsViewModel; readonly selectedChannel: string }) {
  return (
    <div className="route-constraints" role="group" aria-label="Route constraints">
      {model.stops.length > 0 && (
        <ol className="stop-list">
          {model.stops.map((stop, i) => (
            // biome-ignore lint: stops are positional; the index is the stop's identity
            <StopField key={i} index={i} model={stop} selectedChannel={selectedChannel} />
          ))}
        </ol>
      )}
      <div className="route-constraints__actions">
        <button type="button" className="text-button" disabled={!model.canAddStop} onClick={model.onAddStop}>
          Add stop
        </button>
        <label className="checkbox-field">
          <input
            id="avoid-conditional"
            type="checkbox"
            checked={model.riskPolicy === 'avoidConditional'}
            onChange={(e) => model.onRiskPolicyChange(e.target.checked ? 'avoidConditional' : 'recommended')}
          />
          Avoid conditional risks
        </label>
      </div>
    </div>
  );
}

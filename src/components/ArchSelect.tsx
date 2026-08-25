import type { Arch } from '../graph/types';
import type { ArchFieldViewModel } from '../planner/usePlanner';

/** The architecture dropdown: a fixed, always-available list from `ARCHES` -- never loading, never per-channel. */
export function ArchSelect({ id, model }: { readonly id: string; readonly model: ArchFieldViewModel }) {
  return (
    <div className="field">
      <label htmlFor={id}>Architecture</label>
      <select id={id} value={model.value} onChange={(e) => model.onChange(e.target.value as Arch)}>
        {model.options.map((arch) => (
          <option key={arch} value={arch}>
            {arch}
          </option>
        ))}
      </select>
    </div>
  );
}

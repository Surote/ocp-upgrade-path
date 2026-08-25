/**
 * Visible notes for anything that degraded gracefully rather than crashing --
 * a garbage URL param, an unresolvable start/target, a permalinked target
 * that turned out disabled (plan.md Q21). `aria-live="polite"` so a notice
 * that appears after the graph loads (e.g. "start version not found") is
 * announced without stealing focus.
 */
export function Notices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="notices">
      <ul>
        {notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
    </div>
  );
}

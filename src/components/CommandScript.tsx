import { buildScript, type HopCommand } from '../design/commands';
import { CopyButton } from './CopyButton';

/**
 * The full command emitter (plan.md §6): per-hop channel switch (only when
 * one is genuinely required -- "The channel-switch rule") + `oc adm upgrade
 * --to`, plus the whole sequence as one copyable script. A switch line
 * matters when it's there -- forgetting one is a common real upgrade
 * failure -- so it's never collapsed away, and `buildScript` keeps it
 * commented with why. For the plan's own verified example the whole path
 * stays on one channel, so the script that renders here is commonly just
 * the plain `--to` lines with no switch line at all.
 */
export function CommandScript({ commands }: { readonly commands: readonly HopCommand[] }) {
  if (commands.length === 0) return null;
  const script = buildScript(commands);

  return (
    <section className="panel panel--commands" aria-labelledby="commands-heading">
      <div className="panel__head">
        <h2 id="commands-heading">Commands</h2>
        <CopyButton text={script} label="Copy full script" />
      </div>
      <pre className="script-block">
        <code>{script}</code>
      </pre>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';

/**
 * A small "Copy" button for the plain-monospace blocks throughout this phase
 * (PromQL queries, `oc` commands, digests, permalinks) -- per plan.md §5/§6,
 * copying matters far more than any syntax highlighting would.
 *
 * `navigator.clipboard` can be absent (older browser, non-secure context,
 * jsdom in tests) -- failure is swallowed rather than thrown, since the text
 * is always visible to select and copy by hand regardless.
 */
export function CopyButton({ text, label = 'Copy' }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable -- nothing to recover, text stays selectable.
    }
  };

  return (
    <button type="button" className="copy-button" onClick={onClick}>
      {copied ? 'Copied' : label}
    </button>
  );
}

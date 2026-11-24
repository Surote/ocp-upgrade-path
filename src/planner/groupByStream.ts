export interface StreamGroup<T> {
  /** The `major.minor` label, e.g. `5.0`, or `Other` for an item with no parseable stream. */
  readonly stream: string;
  readonly options: readonly T[];
}

/**
 * Splits an already-sorted list into consecutive runs sharing a stream, for
 * one `<optgroup>` per stream. Order is preserved: sort first, then group.
 */
export function groupByStream<T>(sorted: readonly T[], streamOf: (item: T) => string): readonly StreamGroup<T>[] {
  const groups: { stream: string; options: T[] }[] = [];
  for (const item of sorted) {
    const stream = streamOf(item);
    const last = groups.at(-1);
    if (last?.stream === stream) last.options.push(item);
    else groups.push({ stream, options: [item] });
  }
  return groups;
}

/**
 * Plain-language explanation of how a path gets picked, for the operator
 * reading a recommendation -- not a compiler engineer reading the source.
 * Requested directly by the user ("explain how you calculate the path");
 * content follows plan.md §4 and §5.
 *
 * Placed as a collapsed `<details>` in the page footer (App.tsx), below the
 * result section, rather than inline above or beside the result: it answers
 * "how do I trust this", which an operator wants available but not forced on
 * them before they've even seen their answer. A footer section is also the
 * one placement that stays stable regardless of `planner.result`'s state --
 * idle, loading, error or success all render the same footer, so the method
 * explanation is never something that appears only sometimes.
 */
export function MethodExplainer() {
  return (
    <footer className="method-footer">
      <details className="method-details">
        <summary>How is this path calculated?</summary>

        <div className="method-body">
          <h3>Where the data comes from</h3>
          <p>
            Every version and every edge between versions comes from Red Hat's own live Cincinnati graph API
            (<code>api.openshift.com</code>), fetched fresh per channel and CPU architecture — one graph per
            channel+arch combination. This tool never invents a release or an upgrade edge; it only ever reads what
            Red Hat has published.
          </p>

          <h3>How the recommended path is chosen</h3>
          <p>
            Among every possible sequence of hops from your start version to your target, this tool picks the one that:
          </p>
          <ol>
            <li>
              <strong>Takes the fewest hops</strong> — this is checked first and outweighs everything below it.
            </li>
            <li>
              <strong>Then carries the least risk</strong> — each edge's risk weight is <code>2 × (Always risks) + 1 ×
              (conditional risks)</code>. An "Always" risk applies to every cluster taking that edge, so it counts double;
              a conditional (PromQL) risk only applies if your specific cluster matches a query — and this tool has no
              cluster to check that against, so it can only show you the query, never evaluate it for you.
            </li>
            <li>
              <strong>Then prefers the higher patch levels</strong> — among equally-short, equally-risky options, it
              favours landing on the newest patch release at each step (e.g. 4.18.50 over 4.18.2 as an intermediate stop).
            </li>
          </ol>
          <p>
            This is not a shortcut or a heuristic guess — it is an exact algorithm (a lexicographic variant of Dijkstra's
            shortest-path search) that is mathematically guaranteed to find the single best path by those rules, every
            time, without having to look at every possible path. That matters because the number of possible paths is
            enormous: for one worked example (4.18.2 to 4.20.32), there are 243 distinct three-hop routes alone, and a
            brute-force search of every path up to five hops finds 45,563 of them. Checking all of those one by one on
            every search would be far too slow — the ranking algorithm finds the best one directly instead.
          </p>

          <h3>The alternates shown below the map</h3>
          <p>
            Alternates are not "the next-best paths" in some generic sense (a technique called k-shortest-paths) — they
            answer a narrower, more useful question: "if I land on a different intermediate minor release along the way,
            what's the best path through that waypoint?" Up to two such alternates are shown, one per distinct
            intermediate-minor waypoint other than the recommended path's own.
          </p>

          <h3>Stitching across channels</h3>
          <p>
            Sometimes no single Red Hat channel covers both your start and target version, so this tool fetches more than
            one channel's graph and joins them. It only ever joins at a specific release version that is present in{' '}
            <em>both</em> graphs — it never merges or invents an edge that doesn't appear in a single graph Red Hat
            actually publishes. When this happens, a banner names exactly which channels were used, so the path stays
            auditable.
          </p>

          <h3>What is not from the API</h3>
          <p>
            Two things shown alongside the path are this tool's own additions, not something Cincinnati's graph encodes:
            the pre-upgrade acknowledgement (<code>admin-acks</code>) guidance, and the EUS/Control-Plane-Only
            worker-pause advisory. Both are labelled "Guidance, not API-derived" wherever they appear, and both should be
            checked against Red Hat's own documentation before you act on them.
          </p>
        </div>
      </details>
    </footer>
  );
}

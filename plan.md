# Cincinnati Path Planner — Implementation Plan

A static-served web tool that reads Red Hat's OpenShift update graph and answers one
question: what is the safest sequence of releases between the version I run and the
version I want?

| | |
|---|---|
| **Source** | `https://api.openshift.com/api/upgrades_info/v1/graph` |
| **Stack** | Vite · React · TypeScript |
| **Deploy** | GCP Cloud Run |
| **Status** | Design settled (Q1–Q31). No code written. |

---

## 1. The thing it does

The user picks a **channel**, an **architecture**, a **start version** and a **target
version** — all four as dropdowns, each cascading from the one before it, so an
impossible query cannot be constructed. The tool returns the recommended hop sequence,
up to two alternates, and every risk Red Hat has attached to the edges it traverses.

### Verified against the live API during design

The example given — `4.18.2` to `4.20.32` — resolves inside the single `stable-4.20` graph:

```
4.18.2  →  4.18.50  →  4.19.40  →  4.20.32     3 hops, 0 risks on any edge
```

There are **243** distinct 3-hop routes between these two releases. The one above wins
because it is risk-free and has the highest patch sum (50+40+32) — exactly what the §4
cost tuple selects. `4.18.49` is the runner-up on 121 and is equally risk-free; it is a
legitimate route, just tie-broken away.

> **Correction.** Earlier drafts of this document named `4.18.49` as the answer. That came
> from an unranked breadth-first enumeration whose output order was arbitrary — it was
> never the ranked optimum. `4.18.50` and `4.18.51` were present in the graph throughout;
> this was a ranking error, not a stale snapshot.

Note the shape: the minimum is **three** hops, not two. `4.18.2` has no edge to any 4.19
release — it must first climb within 4.18 before it can cross a minor. That intra-minor
climb is exactly the intermediate version the tool exists to surface.

```
4.18   [4.18.2] ────────────────────────► [4.18.50]
                 ╲                            │
                  ╲──► (4.18.49)              │
                                              ▼
4.19                        (4.19.39)     [4.19.40]
                                              │
                                              ▼
4.20                                      [4.20.32]

[solid] = recommended path    (parens) = dimmed alternates
Lanes are minor versions; crossing a lane requires a channel switch.
```

---

## 2. What the API actually gives us

Established by querying the live endpoint, not from documentation.

| Property | Finding | Consequence |
|---|---|---|
| CORS | Open — reflects any `Origin` | Browser *could* call directly; we proxy anyway (Q24) |
| Payload shape | `{version, nodes[], edges[], conditionalEdges[]}` | Two addressing schemes in one document |
| Node | `{version, payload, metadata{…}}` | Errata URL present on all `stable`/`fast` nodes, **but absent on 17/171 `candidate-4.20` nodes** — type it optional |
| Bad channel | HTTP **200** with empty arrays | Validate on content, not status code |
| Conditional updates | Listed **only** in `conditionalEdges`, never also in `edges` (0 overlap across all 7 pinned fixtures) | Fold them into the traversable edge set at parse time; `conditionalEdges` stays the per-edge risk table. Skipping them hid every risk and made e.g. all 4.21→4.22 updates in `stable-4.22` unreachable |
| Graph size | 267 KB → 219 KB trimmed → 27 KB gzip | Whole channel set fits in server memory |
| Risk density | 1175 / 2422 edges (~49%) | Ranking on risk has real signal |
| Risk types | 36 `Always` vs 202 `PromQL` | Hiding conditional risks would hide ~85% of them |

### The trap TypeScript is here to catch

One payload addresses nodes two different ways. `edges` is an array of *integer index
pairs* into `nodes`. `conditionalEdges` uses *version strings*. Conflating them produces
a path that looks plausible and is wrong.

```jsonc
edges:            [[3, 17], [3, 18]]                    // indices into nodes[]
conditionalEdges: [{ edges: [{from:"4.18.22", to:"4.19.10"}],
                     risks: [{ name, message, url, matchingRules[] }] }]
```

### Channel span is not uniform

A channel does not reliably span "this minor and the one before". EUS minors are
even-numbered, and a channel on an EUS minor reaches back to the *previous* EUS minor:

| Channel | Minors spanned | Nodes |
|---|---|---:|
| `stable-4.19` | 4.18, 4.19 | 94 |
| `stable-4.20` | 4.18, 4.19, 4.20 | 124 |
| `stable-4.21` | 4.20, 4.21 | 61 |

This is why the stitcher exists. `4.18.x → 4.20.x` needs one fetch; `4.17.x → 4.21.x`
has no single graph containing both endpoints and must be assembled from several.

---

## 3. Architecture

Static SPA plus a thin proxy, one container.

- **Client — Vite + React + TS.** Cascading dropdowns, path search, SVG rendering.
  Two-tier cache: in-memory `Map` plus `localStorage`, keyed `channel|arch`, 1-hour TTL,
  LRU capped at 8 graphs (~1.8 MB). The trimmed shape keeps per-node **channel
  membership**, interned as ids against a per-graph name table — it costs ~3 KB and feeds
  both the node-detail panel (§6) and seed-and-expand channel discovery (Q6), which
  otherwise has no source for the channel list.
- **Server — Node, ~40 lines.** Serves built assets and proxies `/api/graph` to
  Cincinnati with a shared in-memory cache, 1-hour TTL, stale-while-revalidate. Binds
  `process.env.PORT`.
- **Why proxy at all.** CORS is open today, but a Cloud Run container gives us a server
  for free. One cache serves every user instead of every browser holding its own, and
  Red Hat tightening CORS stops being an outage.
- **Image.** Multi-stage: Node build → `gcr.io/distroless/nodejs22`. Cloud Run:
  unauthenticated, `min-instances=0`, `max-instances=3`, 512 Mi / 1 CPU. Cold start
  ~1–2 s, and that first request warms the cache.

Deploy starts as `gcloud run deploy --source .` from the laptop. It graduates to GitHub
Actions → Artifact Registry → Cloud Run once more than one person touches the repo —
with Workload Identity Federation, never a long-lived service-account key.

---

## 4. Path selection

A naive breadth-first enumeration of `4.18.2 → 4.20.32` at depth ≤ 5 finds **45,563
valid paths**. Enumerate-then-rank is not an option at any UI latency. The search must
return the optimum directly.

**Lexicographic Dijkstra** over a per-edge cost tuple, which encodes the ranking rules
exactly and stays correct even if the graph contains an unexpected cycle:

```
cost(edge) = ( 1,                                    // hop count   — minimise first
               2·|Always risks| + 1·|PromQL risks|,  // risk weight — then this
               -z )                                  // patch level — tie-break high
```

`Always` risks weigh double: they apply unconditionally, whereas a PromQL risk only
bites if the cluster matches the query. A risk carrying both rule types is classified
`Always` — the unconditional rule fires regardless. (No risk in any captured fixture
carries both: 0 of 955.)

**On summing `-z` as a Dijkstra cost.** The tie-break component is not non-negative,
which looks like it should break Dijkstra. It does not. Lexicographic order only requires
the *leading* component to be monotonic, and hop count increments by exactly 1 on every
edge — so extending any path strictly increases its cost in tuple order regardless of
what the trailing components do. The literal cost tuple is sound as written.

**Alternates** are not k-shortest-paths. Yen's algorithm is real complexity for marginal
value here. Instead: the best path per *distinct intermediate-minor waypoint*, capped at
**three paths in total — the recommended one plus up to two alternates** — because "which
4.19.z should I land on" is the actual question an admin is asking. (Earlier wording said
only "capped at three" without saying three of what; the implementation returns two
alternates alongside the primary.)

**Stitching** is target-channel-first. Fetch the target's channel; if the start version
isn't in it, walk back to the same class one stream older (the highest older stream among
the current graph's own nodes, see §6 "Major-version boundaries") until it is. Where two graphs disagree
about an overlapping release, the later channel wins. We never union edges across graphs
— that could synthesise a transition Red Hat has not published in any single channel. A
banner names which channels were stitched, so the path stays auditable.

A stitched result is therefore a *sequential composition of per-segment shortest paths*,
joined only at a version present in both graphs — never a merged adjacency. Junctions are
ranked by hops, then risk weight, then hops walked on a class-fallback channel (§6
"Forward channel preference"), then the patch tie-break. Within one graph every hop shares
a channel, so the extra term never changes a single-graph result. Node metadata
is the one thing that legitimately merges across graphs, under the later-channel-wins
rule. **Multi-graph stitches return the primary path only**; waypoint alternates are
single-graph, because the cheap concatenation trick that makes them nearly free stops
holding once a real channel boundary is crossed. Every worked example in this document
resolves within one graph, so this affects only the long-range cases (`4.17.x → 4.21.x`).

**When no path exists**, say which of the three reasons applies — start version absent
from the graph, target unreachable, or target older than start — and name the nearest
reachable target. If a looser channel has a path, offer it as a one-click retry rather
than silently switching, because auto-promoting someone to `candidate` for a production
cluster is not a decision the tool gets to make.

---

## 5. Risk model

Every risk carries `matchingRules` of type `Always` or `PromQL`. A website has no cluster
to evaluate PromQL against, so it must not pretend to know whether a conditional risk
applies. Both are shown, distinctly marked:

| Label | Meaning | Presentation |
|---|---|---|
| **Always** | Applies to every cluster taking this edge | Sorted first, heavier weight, full message + Jira link |
| **Conditional** | Applies only if the cluster matches the PromQL | Message, Jira link, query in a collapsed block with copy button |

The PromQL is shown as plain monospace, not syntax-highlighted — its purpose is to be
pasted into the cluster's own Thanos or Prometheus to settle whether the risk is real.
Copy matters; colour does not.

Risks appear twice, deliberately. A **deduplicated summary** for the whole path answers
"what am I exposed to overall" — necessary because one risk can recur across many hops
(`HyperShiftRedundantRouter` alone touches 277 edge instances). A **per-hop accordion**
answers "where does it enter".

---

## 6. Interface

- **Cascading inputs.** Channel → arch → start → target. The target list contains only
  genuinely reachable releases; unreachable ones are greyed with the reason attached
  rather than accepted and rejected after submit.
- **Graph.** Fixed layered SVG — one lane per minor, deterministic geometry, recommended
  path solid and alternates dimmed. No layout library: at 3–5 nodes, dagre would be a
  dependency carried for nothing, and force-directed layouts jitter between renders.
- **Nodes.** Version plus a risk-count badge on the node itself. Errata link, payload
  digest and channel membership live in a panel on click. The errata link is omitted
  where absent — release candidates frequently have no advisory yet.
- **Loading & errors.** Only the dropdown actually awaiting data is disabled; never a
  global blocker. When a stitch has three graphs in flight, the error names *which*
  channel fetch failed.
- **Emitted commands.** Per hop: the channel switch and `oc adm upgrade --to <version>`,
  with the digest form on a secondary line for disconnected clusters. Plus the whole
  sequence as one script.
- **Permalink.** Channel, arch, start and target encoded in the query string with a copy
  button. Upgrade plans get pasted into change requests; this makes them linkable. Params
  arrive as untrusted strings and are resolved against the loaded graph before use — an
  unknown version degrades to "unselected" with a visible note, never a wrong selection.

### Look-ahead targets (bidirectional stitching)

**The channel dropdown means "the channel my cluster is on now"**, not "the channel the
target lives in". That reframing is what an operator actually has: they know where they
are, and they want to know how to get somewhere ahead.

So the target dropdown must offer versions **beyond the selected channel's span**.
Selecting `eus-4.20` (which spans 4.18–4.20) must still offer `4.22.9` as a target, and
the resulting path must name the point where the channel has to change.

Verified against the live API:

| Channel | Span | |
|---|---|---|
| `eus-4.20` | 4.18, 4.19, 4.20 | `4.22.9` not present |
| `eus-4.22` | 4.20, 4.21, 4.22 | `4.18.2` not present |
| overlap | **32 shared 4.20.x releases** | the join |

`4.18.2 → 4.22.9` therefore requires both graphs and a genuine channel switch at a shared
4.20.x release. The stitcher becomes **bidirectional**: the selected channel is an anchor,
walked *backward* when the start is missing and *forward* when the target is.

**Forward channel preference.** Prefer the same class (`eus-4.20 → eus-4.22`). Where that
class has no channel at a needed stream — EUS is even-only, so `eus-4.21` does not exist —
fall back to `stable`, then `fast`, then `candidate` at that stream, and **say so in the
UI**, because moving an operator from `eus` to `stable` (or onto `candidate`) changes their
support posture and is not a silent detail. The `candidate` tail exists for new streams:
it reaches a target that is published *only* in candidate (5.0 at first). That is not the
silent auto-promotion §4 rules out: the operator picked a candidate-only release, and the
banner says the plan relies on a pre-release channel.

**This requires per-hop segment provenance in the engine.** `stitchPrimaryAcrossSegments`
currently flattens every segment's hops into one `Path`, so nothing records which graph a
hop came from — which is exactly why multi-graph paths could not attribute channel
switches. `PathHop` must carry its source segment for this feature to be correct.

> **Implemented.** `PathHop.sourceChannel` (engine/types.ts) now carries this on every hop
> the stitcher returns, single- or multi-graph alike. `stitchAndFindPath`
> (engine/stitch.ts) is bidirectional: it fetches the anchor once, then walks backward to
> cover `start` and/or forward to cover `target` as needed, in the same fetch. Forward
> walking starts at the *target's own stream* (not one past the anchor), so a channel
> that already reaches back far enough — `eus-4.22` sharing the 4.20.x band with
> `eus-4.20` — joins directly with no unnecessary intermediate channel, exactly matching
> the table above. A class fallback (`StitchInfo.classFallbacks`) is surfaced in both the
> target dropdown (`TargetSelect`, "drops to <class>") and the result banner
> (`StitchBanner`) when it's used. See the forward-walk tests in
> `engine/__tests__/stitch.test.ts` for the exact algorithm, including the
> multi-stream-with-fallback case.

### Major-version boundaries (4.22 → 5.0)

Channel names are `<class>-<major>.<minor>`, parsed in one place (`design/channels.ts`,
`ChannelName = { cls, major, minor }`) and ordered by `(major, minor)`. Verified against
the live API on 2026-11-01:

| Channel | Nodes | Content |
|---|---:|---|
| `stable-4.22`, `fast-4.22`, `eus-4.22` | 104 | 4.20.0 … 4.22.20 |
| `candidate-4.23` | 36 | 4.22.z plus 4.23.0-ec.* |
| `candidate-5.0` | 51 | 4.22.z plus 5.0.0-ec.*, 5.0.0-rc.0 … rc.8, 5.0.0 |
| `candidate-5.1` | 20 | 4.23.0-ec.*, 5.0.0-ec/rc, 5.1.0-ec.* |
| `stable-4.23`, `fast-4.23`, `stable-5.0`, `fast-5.0`, `eus-5.0`, `stable-5.1` | 0 | empty |

**Stream succession is read from data, never computed.** "The stream before 5.0" is not
`5.-1`, and "the stream after 4.22" is both 4.23 and 5.0. Two facts in every graph answer
it directly:

- *Walking toward older streams* (the stitcher's backward walk, and its forward walk
  stepping down from the target): a channel's nodes include its upgrade sources, so the
  previous stream is the highest stream among its own nodes below its own
  (`candidate-5.0` → 4.22).
- *Walking toward newer streams* (look-ahead discovery): each node's membership lists the
  newer channels it is an upgrade source for (`stable-4.22` nodes name `candidate-4.23`
  and `candidate-5.0`). Discovery fetches only those named channels, lowest stream first.

So `stable-4.22`, start 4.22.z, target 5.0.0-rc.x stitches `stable-4.22` → `candidate-5.0`
and emits `oc adm upgrade channel candidate-5.0` at the last `stable-4.22` station on the
path, with the banner marking the candidate fallback. `candidate-5.0` lists nearly every
4.22.z, so "the first station it lists" would be the start itself; joining a fallback
class is deferred instead (see "Where the switch is attributed matters"). Among equally
short, equally risky routes the stitcher also prefers the one with the fewest hops on a
fallback channel, ahead of the patch tie-break: `4.22.3 → 4.22.20 → 5.0.0-rc.8` over
`4.22.3 → 4.22.21 → 5.0.0-rc.8`, since 4.22.21 is published only in `candidate-5.0`.

### Formerly: "Known limitation: the UI cannot reach the stitcher"

The start dropdown is populated from the **selected channel's own graph** — the same
graph that feeds the target list. The selected channel is the *target's* channel, and its
graph may not contain the start version at all: `stable-4.21` spans only {4.20, 4.21}, so
a 4.19 start is not in it.

> **Partially resolved.** The bidirectional stitcher (above) means a genuine multi-graph
> stitch is now reachable through the interface — but only via the **forward** direction:
> selecting `eus-4.20` and a *target* dropdown option beyond it (`4.22.9`) reaches the
> stitcher's backward-*and*-forward code path exactly as described here. The **backward**
> half of this specific limitation is unchanged and still real: the *start* dropdown is
> still populated only from the selected channel's own graph, so `4.17.x → 4.21.x` (a pure
> backward stitch, no look-ahead involved) is still unreachable through the interface —
> closing that still needs a start dropdown that unions versions across the walk-back
> channels, which is out of scope for this pass. The interchange ring and switch commands
> are therefore no longer purely dormant (see "The channel-switch rule" below), but they
> still can't be reached via a backward-only multi-graph stitch from the UI.

### Two Phase 4 deviations, recorded

**Alternates are not drawn in the map.** §6 says "recommended path solid and alternates
dimmed" *in the graph*. They render instead as a subordinate panel of lane-coloured chips
below the map. Branching lane geometry for paths of differing lengths is real layout work
and was traded away; the alternates still use the same lane-colour language.

**Channel-membership badges are suppressed on multi-graph stitches.** `nodeInfo` merges
`GraphNode`s across source graphs, but carries no per-source `channelNames` table — so a
node's `channels` indices cannot be safely resolved against the *selected* channel's table
once more than one graph was fetched. The station panel says so rather than risking a
mislabelled channel. Fixing this means carrying the name table per source graph through
the stitch result.

> Still true, and now hit more often: the look-ahead target feature means a genuine
> multi-graph stitch is a normal, reachable outcome (not just a theoretical one), so this
> suppression is now visible in ordinary use rather than only in tests. Left as-is for this
> pass — it's an orthogonal gap (`channelNames` plumbing), not something the bidirectional
> stitcher needed to touch, and `PathHop.sourceChannel` (new this pass) doesn't help here
> since this is about a *node's* membership table, not a hop's source.

### Channel ordering is an opinion

Channels sort by stream (major, then minor, newest first), then by class `stable → eus → fast → candidate`. That class order
is a **UI judgment about production risk appetite, not something the API encodes** — the
wire data carries no ordering signal at all. Worth revisiting if it reads wrong to
operators.

### Command output, for the verified example

```sh
oc adm upgrade --to 4.18.50
oc adm upgrade --to 4.19.40
oc adm upgrade --to 4.20.32
```

**No channel switch appears here, and that is correct.** Every version on this path is a
member of `stable-4.20` — verified from the graph's own per-node channel metadata:

| Version | member of `stable-4.20` | member of `eus-4.20` |
|---|---|---|
| 4.18.2 | yes | yes |
| 4.18.50 | yes | yes |
| 4.19.40 | yes | yes |
| 4.20.32 | yes | yes |

### The channel-switch rule

Earlier drafts of this document stated the rule as *"crossing a minor requires the
switch"*. **That is wrong**, and it produced two real defects:

1. It emitted a switch on every minor crossing even when the whole path lives in one
   channel — as above, where the cluster stays on `stable-4.20` throughout.
2. It **synthesised** channel names as `<class>-4.<minor>`. With `eus-4.20` selected and a
   path crossing 4.19, that yields `oc adm upgrade channel eus-4.19` — **a channel that
   does not exist**, since EUS minors are even-only.

The correct rule is membership, and the data for it is already stored (`GraphNode.channels`
indexing `Graph.channelNames`):

> Emit a channel switch only when the hop's destination version is **not a member of the
> channel the cluster is currently on**. Switch to a channel that version actually belongs
> to — never to a name assembled from a class and a minor.

**Where the switch is attributed matters.** The command runs while the cluster is standing
on a release, so the switch belongs to **the earliest station on the path that is already a
member of the destination channel** — not to the destination of the hop that leaves the old
channel.

Worked example, `eus-4.20` → `4.22.9`:

| Station | member of `eus-4.22` |
|---|---|
| 4.18.2 | no |
| 4.18.51 | no |
| 4.19.41 | no |
| **4.20.33** | **yes ← switch here** |
| 4.21.28 | yes |
| 4.22.9 | yes |

The cluster reaches 4.20.33 on `eus-4.20`, and 4.20.33 is also in `eus-4.22`, so that is the
first point the switch is possible — and therefore where the map's interchange marker and
the `oc adm upgrade channel` line belong. Marking 4.21.28 is wrong: by then the switch has
already had to happen.

The exception is a switch *into* a class fallback (`eus` → `stable`, `stable` →
`candidate`). Switching there as early as possible would move the cluster off its own
class for longer than the path needs, so that switch stays at the last station the path
spends on the earlier channel.

A channel name must never be constructed; it must only ever be read from real membership
data or from the set of channels the stitcher actually fetched.

> **Implemented.** `stitchPrimaryAcrossSegments`'s layered DP (engine/stitch.ts) picks its
> segment boundary for path *cost* (fewest hops, then risk, then patch level) or plain edge
> availability, not for early attribution -- so on a path where several *consecutive*
> stations all belong to the destination channel, the DP's own boundary can legitimately
> land later than the earliest one (see `stitch.test.ts`'s "several consecutive shared
> stations" case, where the forward channel's own edges only start from the *last* of three
> shared 4.20.x stations). `reattributeSwitches` (engine/stitch.ts) runs immediately
> after the DP and relabels `PathHop.sourceChannel` to the earliest station on the path that
> is a real member of the channel about to be used, checked directly against each fetched
> segment's own node list (`versionsOf`, never a constructed name) -- a pure relabelling
> pass that never changes which versions or edges are on the path. It's applied per
> crossing independently, so a path through three-or-more channels gets each boundary
> corrected on its own. `design/commands.ts` was already comparing consecutive hops'
> `sourceChannel` correctly; the remaining bug was that `UpgradeMap` and `HopDetail` both
> anchored the switch on the *arriving* station (`hop.to`) of the hop carrying
> `channelSwitch`, one station later than where the switch actually happens -- both now key
> off `hop.from` instead, so the ring, the inline tag, and the hop-detail copy all name the
> same station the command sequence already implied.

**Consequence: within a single-graph query, a channel switch can never be required.**
Verified across all five pinned fixtures — 546 nodes total, **zero** that are not members
of the channel that returned them. That is how Cincinnati's filtering works: a channel
query returns exactly that channel's members. So for any path the UI can currently
construct, `currentChannel` never fails the membership test and no switch is emitted.

A switch is only ever genuinely needed across a true multi-graph stitch. At the time this
was written, the UI could not reach one at all (see "Known limitation" above), so the
interchange ring was correct, tested, and dormant in the shipped product. Earlier drafts
of this document treated the forgotten channel switch as a headline hazard; on the
evidence that framing was overstated for this tool's actual usage at the time.

> **No longer dormant.** The look-ahead target feature (above) gives the UI a real path to
> a genuine multi-graph stitch — the forward direction, specifically. `PathHop` now
> carries `sourceChannel` (engine/types.ts), so `design/commands.ts` can attribute a
> switch to exactly the hop that crosses a real segment boundary, using the actual fetched
> channel name — never a guess, never a name assembled from a class and a minor. The
> "channel name must never be constructed" rule above is unchanged and, if anything, more
> load-bearing now: `sourceChannel` is always one of the channels `stitchAndFindPath`
> itself fetched. The single-graph invariant just above ("a channel switch can never be
> required") is *also* unchanged and now falls out of the same mechanism for a different
> reason: every hop of a single-graph path shares the same `sourceChannel` (there's only
> one fetched graph), so the comparison that would trigger a switch can never fire.

Note also that `PathHop` used to carry no record of which fetched segment produced it —
`stitchPrimaryAcrossSegments` flattened all segments into one `Path`. Per-hop switch
attribution needed the engine to return segment provenance; it now does
(`PathHop.sourceChannel`), and multi-graph paths emit real, correctly-attributed switch
commands rather than none at all.

### Pre-upgrade acknowledgements (admin-acks)

Before a cluster will cross certain minors, an administrator must acknowledge pending
Kubernetes API removals by patching the `admin-acks` ConfigMap. The CVO blocks the upgrade
until this is done. Cincinnati does not encode it.

Verbatim from Red Hat's public docs (4.20):

```sh
oc -n openshift-config patch cm admin-acks   --patch '{"data":{"ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20":"true"}}'   --type=merge
```

**Ack keys are not synthesisable and not universal.** Collected from each destination
version's own "Preparing to update a cluster" page:

| Entering | Ack key(s) |
|---|---|
| 4.14 | `ack-4.13-kube-1.27-api-removals-in-4.14` |
| 4.16 | `ack-4.15-kube-1.29-api-removals-in-4.16` |
| 4.19 | `ack-4.18-gateway-api-management-in-4.19` **and** `ack-4.18-kube-1.32-api-removals-in-4.19` |
| 4.20 | `ack-4.19-admissionregistration-v1beta1-api-removals-in-4.20` |
| 4.22 | `ack-4.21-boot-image-opt-out-in-4.22` |
| 4.17, 4.18, 4.21 | none found on the destination page |

Note 4.19 needs **two**, and several minors need none — so the key must never be built from
a pattern. Where no key was found, the UI must say *"none documented — confirm via the KCS"*,
never *"no acknowledgement required"*; absence of a key on a page is not proof of absence.

**KCS articles** (verified titles, one per destination minor):

| Minor | KCS | Minor | KCS |
|---|---|---|---|
| 4.9 | 6329921 | 4.16 | 7031404 |
| 4.12 | 6955381 | 4.19 | 7112216 |
| 4.13 | 6958394 | 4.20 | 7130599 |
| 4.14 | 6958395 | | |

For a minor with no verified ID, link a KCS **search** rather than a guessed article id.

### The EUS advisory

**EUS minors are even-numbered *and* 4.6 or later.** Verified exhaustively against the
live API across 4.1–4.23: every even minor from 4.6 to 4.22 has a populated `eus-4.N`
channel; every odd minor returns zero nodes; and every even minor *below* 4.6 also returns
zero nodes, because EUS did not exist before 4.6. Parity alone is not the rule — an
even-only test misfires on a 4.4 → 4.6 plan, which the UI can genuinely construct
(`stable-4.4` has 53 nodes). Earlier drafts of this document stated the rule as "even"
without the floor.

| Minor | 4.1–4.5 | 4.6 | 4.7 | 4.8 | … | 4.20 | 4.21 | 4.22 | 4.23 |
|---|---|---|---|---|---|---|---|---|---|
| `eus-4.N` nodes | 0 | 52 | 0 | 125 | alternating | 124 | 0 | 71 | 0 |

**Red Hat has renamed this procedure.** It is now documented as a **"Control Plane Only
update"**, not "EUS-to-EUS". The old link this app shipped —
`.../updating_clusters/preparing-eus-eus-upgrade` — **404s**. The working URL is
`.../updating_clusters/performing-a-cluster-update#control-plane-only-update`, confirmed
for both 4.20 and 4.22.

An EUS-to-EUS upgrade such as 4.18 → 4.20 requires pausing worker MachineConfigPools so
nodes reboot once instead of twice. **Cincinnati does not encode this.** The tool detects
the shape — start and target both on EUS minors, two or more minors crossed — and shows
the `oc patch mcp` guidance in a visually separate block, cited to Red Hat's
documentation and explicitly labelled as guidance rather than API-derived data. It is the
highest-value thing a 4.18 → 4.20 planner needs, and precisely the thing the graph will
not tell them.

---

## 7. Build order

Each phase leaves something runnable.

1. **Graph client and types.** ✅ *Complete — 52 tests.* Typed fetch, response validation, the trimmed cache shape,
   both cache tiers. Distinct branded types for node index and version string so the two
   addressing schemes cannot be mixed.
2. **Path engine.** ✅ *Complete — 102 tests cumulative.* Lexicographic Dijkstra, risk weighting, waypoint alternates, the
   stitcher. Vitest against pinned real fixtures — `4.18.2 → 4.20.32` must return the
   three-hop path — plus synthetic mini-graphs for no-path, cycles and stitch conflicts.
   Tests never hit the network.
3. **Inputs.** ✅ *Complete — 164 tests cumulative.* Cascading dropdowns, seed-and-expand channel discovery, URL state, loading
   and error states.
4. **Output.** ✅ *Complete — 200 tests cumulative.* Layered SVG, risk summary and per-hop accordion, node detail panel,
   command emitter, EUS advisory.
5. **Ship.** ⬜ *Next.* Proxy server, Dockerfile, `gcloud run deploy --source .`, then Actions with
   Workload Identity Federation.

---

## 8. Decision log

**Q2 · Q24 — Static SPA, plus a server-side proxy.** The SPA was chosen when the target
was a static host and infrastructure cost was the deciding factor. Cloud Run changed that
input: a container is running regardless, so the proxy became close to free and brought a
shared cache and CORS independence with it.

**Q3 · Q10 — Stitch channels; never union them.** Target-channel-first, walking back
until the start version is covered, later channel winning on conflict. Unioning edges
across graphs could invent a transition that appears in no single published channel.

**Q4 · Q9 — Lexicographic Dijkstra over a cost tuple.** Hops, then risk weight, then
patch level. Chosen over a tuned scalar cost because there is no constant to justify, and
over topological DP because it stays correct if the graph is not the DAG we assume.

**Q5 · Q17 · Q31 — Show conditional risks; never hide them.** PromQL-gated risks
outnumber unconditional ones roughly six to one. Suppressing them would hide most of the
risk surface. They are labelled as conditional and the query is shown for the operator to
evaluate themselves.

**Q6 · Q7 — Seed-and-expand channel discovery.** There is no endpoint listing channels —
only node metadata naming them, which requires a graph to read. One known-good channel
fetched at load yields the real channel names; the list expands as the user navigates.
Nothing hardcoded to rot.

**Q12 — Waypoint alternates, not k-shortest-paths.** Yen's algorithm answers a question
nobody asked. Grouping by intermediate minor answers the one they did.

**Q14 · Q19 · Q28 — Two cache tiers, 1-hour TTL.** Server-side shared cache with
stale-while-revalidate; client-side LRU capped at 8 trimmed graphs. No boot warming —
that would slow cold starts on a scale-to-zero service, which is backwards. A visible
fetch timestamp and manual refresh prevent anyone planning a production upgrade against
stale data.

**Q13 · Q22 — TypeScript, tested against real fixtures.** The index-versus-version
addressing split is exactly the class of bug types catch. Pinned real fixtures prove the
ranker against paths verified live; synthetic graphs cover the edge cases real data does
not contain.

**Q20 — EUS worker-pause guidance is included, and marked as guidance.** Not present in
the API. Included because it is what the 4.18 → 4.20 planner most needs; visually
separated and cited so it is never mistaken for something Cincinnati asserted.

**Q23 · Q26 · Q27 — Cloud Run, public, scale-to-zero.** Unauthenticated with
`min-instances=0`. Raise to 1 only if cold start proves unacceptable for a
customer-facing audience. Laptop deploys first; Workload Identity Federation when CI
arrives.

---

All API characteristics in this document were measured against `api.openshift.com` during
the design session, not taken from documentation. Graph contents change on Red Hat's
release cadence — the node counts and risk densities are a snapshot, the structural
findings are not.

# Apollo Client 3.14.1 React commit fragmentation benchmark

[Run the benchmark in your browser](https://superliaye.github.io/apollo-react-commit-benchmark/)

This repository isolates a React scheduling difference observed while upgrading Apollo Client from 3.6.9 to 3.14.1. In the tested application shape, both versions process the same cache result and reach the same final UI, but 3.14.1 can publish that update through more React commits.

The stable result is the commit pattern. Millisecond timings depend on the browser and machine and are supporting evidence only.

## The result

One in-memory cache write reaches several independently mounted components that each call `useQuery` for the same query:

| Independent `useQuery` consumers | Apollo 3.6.9 | Apollo 3.14.1 | Grouped-delivery diagnostic |
| ---: | ---: | ---: | ---: |
| 1 | 2 commits | 2 commits | 2 commits |
| 2 | 2 commits | 4 commits | 2 commits |
| 4 | 2 commits | 8 commits | 2 commits |
| 8 | 2 commits | 16 commits | 2 commits |

One consumer is the negative control: both versions produce two commits. As subscriber fan-out increases, stock 3.14.1 produces `2N` commits at every tested count, while stock 3.6.9 and the grouped-delivery diagnostic remain at two.

This does not mean every Apollo 3.14.1 application is slower. The effect requires multiple independently mounted `useQuery` consumers whose deliveries reach React separately. Apollo may deduplicate their network request, but each mounted `useQuery` remains a separate React subscriber. Reading the query once and distributing its result through props or context creates one delivery, not N.

## The causal chain

The benchmark removes network and product code so one controlled cache write can be traced end to end:

```text
cache.writeQuery(changedResult)
  ↓
Apollo notifies N watched ObservableQuery instances
  ↓
each observer result is delivered in a separate zero-delay browser task
  ↓
┌───────────────────────────────┬────────────────────────────────────┐
│ Apollo 3.6.9                  │ Apollo 3.14.1                     │
│ setTick(...)                  │ handleStoreChange()               │
│ ordinary React state update   │ useSyncExternalStore update       │
│ DefaultLane in this context   │ forceStoreRerender(..., SyncLane) │
└───────────────────────────────┴────────────────────────────────────┘
  ↓                               ↓
compatible work can stay          React can flush synchronously
pending and coalesce               before the next delivery task
  ↓                               ↓
one combined query commit          one query commit per consumer
  ↓                               ↓
one combined parent commit         one parent commit per consumer
```

React 18 automatic batching does not guarantee that synchronous external-store updates arriving in different browser tasks share a commit. In this fixture, the 3.14.1 callback can flush before Apollo starts the next delivery task.

The `DefaultLane` versus `SyncLane` explanation is traced to the pinned Apollo and React sources. The benchmark directly manipulates delivery-task grouping; it does not independently manipulate React lanes.

## What Q and D mean

The browser timeline labels two kinds of React commit:

- **Q — query-result commit:** one or more `useQuery` consumers publish the new Apollo cache value to the UI.
- **D — derived parent-state commit:** after Q, those consumers' `useLayoutEffect` callbacks read DOM geometry and call a shared parent state setter. D is downstream React work supplied by the fixture; it is not another GraphQL result or another Apollo cache write.

The relevant component shape is:

```tsx
function QuerySubscriber({ publishDerivedState, rows }) {
  const { data } = useQuery(SHARED_ITEM, { fetchPolicy: "cache-only" });
  const value = data?.benchmarkItem?.value;

  useLayoutEffect(() => {
    mount.getBoundingClientRect();
    publishDerivedState();
  }, [value]);

  return <ResultRows count={rows} value={value} />;
}

{Array.from({ length: N }, (_, index) => (
  <QuerySubscriber
    key={index}
    rows={rows}
    publishDerivedState={() => setDerivedVersion(version => version + 1)}
  />
))}
```

Here, `rows` is the DOM-rows-per-subscriber control; the browser runner defaults it to 400.

With Apollo 3.6.9, all consumers can publish together in one Q commit. Their layout effects then schedule compatible parent updates that combine into one D commit:

```text
Q · all N  →  D · combined  = 2 commits
```

With Apollo 3.14.1, each consumer can publish before the next delivery task starts. Each Q commit runs that consumer's layout effect, which schedules its own D commit:

```text
Q1 → D1 → Q2 → D2 → … → QN → DN  = 2N commits
```

D makes commit fragmentation visible as user-relevant downstream work: real applications often measure children, register rows, update summaries, or synchronize parent state after data renders. The exact D workload is a benchmark model, not an assertion that every product component uses this layout effect.

## Why extra commits can cost time

A render is React calculating the next UI. A commit applies one completed result to the DOM and runs layout effects. Many component renders can share one commit.

Splitting one logical result across more commits can repeat:

- shared parent rendering;
- DOM mutation and style work;
- layout-effect execution and synchronous geometry reads;
- downstream state publication.

The fixture intentionally leaves consumers non-memoized and recreates their callback prop. That amplifies secondary render-count and React-CPU differences when parent state changes. Memoized consumers with stable callbacks would reduce that secondary amplification, but not the primary commit sequence measured here.

## How the benchmark tests causality

The experiment uses three arms:

1. **A — Apollo 3.6.9 stock:** the exact published older package.
2. **B — Apollo 3.14.1 stock:** the exact published newer package.
3. **C — Apollo 3.14.1 grouped-delivery diagnostic:** the same package, React path, values, ordering, component tree, and final UI as B; only pending observer callbacks are drained in one shared task.

If separate React-facing delivery tasks drive the fragmentation, grouping only those deliveries should restore the two-commit pattern without changing values or final UI. The tested counts follow that prediction.

The diagnostic is causal evidence, not a production patch. It relies on Apollo private objects and adds one task of queueing delay. Apollo [PR #11083](https://github.com/apollographql/apollo-client/pull/11083) introduced the external-store path to fix update ordering, so restoring the old setter blindly could restore that correctness bug.

## What is measured

The clock starts immediately before one changed `cache.writeQuery` and includes:

- Apollo cache publication and observer delivery;
- React rendering and DOM commits;
- real layout effects and `getBoundingClientRect` reads;
- derived parent updates;
- the final commit and two animation frames.

It excludes network time, server time, application business logic, synthetic busy loops, and artificial “commit tax.” Every accepted sample also verifies exact loaded versions, one cache write, notification and observer counts, task/microtask/commit ordering, unchanged value order, identical final snapshots and checksums, and agreement between React Profiler commits and layout-effect snapshots.

## Run locally

Install [Bun](https://bun.sh/), then:

```bash
bun run check
bun run dev
```

Open the printed URL and press **Run proof**. The browser UI defaults to subscriber counts `1,2,4,8`, four balanced blocks, and 400 real DOM rows per subscriber. It discards warmups and runs 96 measured samples in mirrored `ABCCBA` / `CBAABC` order.

The checked-in [`results/reference-run.json`](results/reference-run.json) is the reviewed 96-sample result collected with 40 rows per subscriber. The row count changes the amount of real DOM work and timing, not the expected commit-count proof conditions.

The live page imports exact packages from [esm.sh](https://esm.sh/): Apollo Client 3.6.9 and 3.14.1, React 18.3.1, and `react-dom@18.3.1/profiling`. An unavailable or mismatched package fails the proof instead of silently changing the environment.

## Public source trail

- [Apollo PR #11083: behavior change and correctness motivation](https://github.com/apollographql/apollo-client/pull/11083)
- [Apollo 3.6.9 local state setter](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L68-L77)
- [Apollo 3.6.9 subscription path](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L137-L160)
- [Apollo 3.14.1 passes the store-change handler](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L415-L450)
- [Apollo 3.14.1 invokes it from `setResult`](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L688-L719)
- [React 18.3.1 external-store updates use `SyncLane`](https://github.com/facebook/react/blob/v18.3.1/packages/react-reconciler/src/ReactFiberHooks.old.js#L1478-L1506)
- [Apollo issue #10364: a related duplicate-subscriber precursor, not proof of this version-specific path](https://github.com/apollographql/apollo-client/issues/10364)

## Scope

This benchmark establishes a reproducible mechanism for this query-subscriber shape. It does not establish that every Apollo 3.14.1 application is slower, that timing deltas generalize to another screen, that the non-memoized render/CPU multiplier is universal, that lanes were independently varied, that other query shapes, fetch policies, or React versions follow this exact path, or that the diagnostic intervention is safe to ship.

## Repository map

- `index.html` — focused live runner, result timeline, and pinned source paths
- `src/benchmark.ts` — benchmark, instrumentation, validation, and result rendering
- `src/shared-observer-delivery-task-patch.ts` — grouped-delivery diagnostic
- `benchmark.js` — committed browser bundle produced by Bun
- `results/reference-run.json` — reviewed 96-sample reference run
- `scripts/check-content.ts` — build and public-content audit

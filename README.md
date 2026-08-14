# Apollo / React commit scheduling lab

[Run the benchmark in your browser](https://superliaye.github.io/apollo-react-commit-benchmark/)

## The problem

One Apollo cache write can reach several independently mounted React components that each call `useQuery` for the same query. In this tested shape:

| Eight independent subscribers | React commits | Final UI |
| --- | ---: | --- |
| Apollo Client 3.6.9, unchanged | 2 | Identical |
| Apollo Client 3.14.1, unchanged | 16 | Identical |
| Apollo Client 3.14.1, grouped-delivery diagnostic | 2 | Identical |

A **render** is React calling component functions to calculate the next UI. A **commit** is React applying one completed result to the DOM and running commit-phase effects. Many renders can share one commit.

The problem is therefore not extra result data. Apollo 3.14.1 can split one logical screen update across more commit boundaries. Each boundary can repeat parent rendering, DOM mutation, layout effects, and downstream state work before reaching the same final screen.

```text
one cache write reaches N independent useQuery consumers
measured at N = 1, 2, 4, and 8

A · Apollo 3.6.9
  [all N query consumers together] + [one parent update] = 2 at every tested N

B · Apollo 3.14.1
  ([one query consumer] + [one parent update]) × N        = 2N at every tested N
                                                           = 16 when N = 8
```

Eight is not a special Apollo number. It is the largest default test case, chosen to make the scaling difference easy to see. The suite also runs 1, 2, and 4 consumers.

React 18 automatic batching does not guarantee that synchronous external-store updates arriving in separate browser tasks will share a commit.

## Why the versions differ here

The pinned public source paths are:

```text
Apollo 3.6.9
  observer result → local setTick(...) → requestUpdateLane(...)

Apollo 3.14.1
  observer result → handleStoreChange()
                  → forceStoreRerender(..., SyncLane)
```

Apollo 3.6.9 routes a delivered query result through an ordinary local state setter. In this tested outside-event context, React gives that work `DefaultLane` priority, so compatible pending work can combine before a commit.

Apollo 3.14.1 routes the result through the `useSyncExternalStore` change callback. React 18.3.1's external-store consistency path explicitly schedules `SyncLane`; its microtask can commit before Apollo's next separate delivery task begins.

The benchmark directly manipulates **delivery-task grouping**. `DefaultLane` versus `SyncLane` is the source-traced explanation for the pinned versions; lanes are not independently manipulated by a benchmark arm.

Apollo [PR #11083](https://github.com/apollographql/apollo-client/pull/11083) introduced the external-store callback to fix update ordering. Restoring the old setter blindly could restore that correctness bug.

## Why this benchmark exists

Product traces can reveal extra commits, but network timing and application-specific work make the cause hard to isolate. This fixture removes the network while keeping the relevant React pressure:

```text
ApolloProvider
└─ shared parent summary
   └─ QuerySubscriber × N
      ├─ useQuery(shared query)
      ├─ 40 real DOM rows
      └─ useLayoutEffect
         ├─ read real geometry
         └─ update parent summary
```

The measured input is one in-memory cache write:

```tsx
function QuerySubscriber({ publishDerivedState }) {
  const { data } = useQuery(SHARED_ITEM, { fetchPolicy: "cache-only" });
  const value = data?.benchmarkItem?.value;

  useLayoutEffect(() => {
    mount.getBoundingClientRect();
    publishDerivedState();
  }, [value]);

  return <ResultRows count={40} value={value} />;
}

{Array.from({ length: N }, (_, i) => (
  <QuerySubscriber
    key={i}
    publishDerivedState={() => setDerivedVersion(v => v + 1)}
  />
))}

client.cache.writeQuery({ query: SHARED_ITEM, data: changedResult });
```

The required shape is **N independently mounted `useQuery` calls**. Apollo may deduplicate their network request, but their React subscribers remain separate. Querying once and sharing the result through props or context creates one query delivery, not N.

The fixture intentionally leaves consumers non-memoized and recreates their callback prop. That makes fragmented parent commits amplify the secondary subscriber-render and React-CPU totals. Memoized consumers with stable props and callbacks would reduce that amplification, but not the primary 2-versus-16 commit split.

## How the three arms test causality

1. **A — Apollo 3.6.9 stock:** the exact published older package.
2. **B — Apollo 3.14.1 stock:** the exact published newer package.
3. **C — Apollo 3.14.1 diagnostic:** the same package, React path, values, order, tree, and final UI as B; only pending observer callbacks are drained in one shared task.

If separated React-facing deliveries are necessary for fragmentation, one subscriber should be a negative control and increasing subscribers should produce this dose response:

| Independent subscribers | A: 3.6.9 | B: 3.14.1 | C: grouped 3.14.1 |
| ---: | ---: | ---: | ---: |
| 1 | 2 | 2 | 2 |
| 2 | 2 | 4 | 2 |
| 4 | 2 | 8 | 2 |
| 8 | 2 | 16 | 2 |

That is the exact reviewed reference result. Every accepted sample also verifies the loaded versions, one cache write, notification and observer counts, task/microtask/commit ordering, unchanged value order, identical final snapshots and checksums, and agreement between React Profiler commits and layout-effect snapshots.

The diagnostic intervention is causal evidence, **not a production-ready fix**. It uses Apollo private objects and adds one task of queueing delay.

## What is measured

The clock starts immediately before `cache.writeQuery` and includes cache publication, Apollo observer delivery, React rendering, DOM commits, real layout effects and geometry reads, derived parent updates, the final commit, and two animation frames.

It excludes network time, server time, application business logic, synthetic CPU loops, and artificial “commit tax.” Commit count and intermediate snapshots are deterministic checks. Millisecond timing varies by browser and machine and is supporting evidence only.

## Run locally

Install [Bun](https://bun.sh/), then:

```bash
bun run check
bun run dev
```

Open the printed URL and press **Run proof**. The default suite mounts 1, 2, 4, and 8 subscribers, renders 40 DOM rows per subscriber, discards warmups, and runs 96 measured samples in mirrored `ABCCBA` / `CBAABC` order.

The live page imports exact packages from [esm.sh](https://esm.sh/): Apollo Client 3.6.9 and 3.14.1, React 18.3.1, and `react-dom@18.3.1/profiling`. The profiling renderer reports `18.3.1-next-f1338f8080-20240426`. An unavailable or mismatched package fails the proof instead of silently changing the environment.

## Public source trail

- [Apollo PR #11083: behavior change and correctness motivation](https://github.com/apollographql/apollo-client/pull/11083)
- [Apollo 3.6.9 local state setter](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L68-L77)
- [Apollo 3.6.9 subscription path](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L137-L160)
- [Apollo 3.14.1 passes the store-change handler](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L415-L450)
- [Apollo 3.14.1 invokes it from `setResult`](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L688-L719)
- [React 18.3.1 external-store updates use `SyncLane`](https://github.com/facebook/react/blob/v18.3.1/packages/react-reconciler/src/ReactFiberHooks.old.js#L1478-L1506)
- [Apollo issue #10364: a related duplicate-subscriber precursor, not proof of this version-specific path](https://github.com/apollographql/apollo-client/issues/10364)

## Repository map

- `index.html` — newcomer-oriented explanation and live runner
- `src/benchmark.ts` — benchmark, instrumentation, validation, and result rendering
- `src/shared-observer-delivery-task-patch.ts` — diagnostic intervention
- `benchmark.js` — committed browser bundle produced by Bun
- `results/reference-run.json` — reviewed 96-sample reference run
- `scripts/check-content.ts` — build and public-content audit

## Scope

This benchmark establishes a reproducible mechanism for this query-subscriber shape. It does not establish that every Apollo 3.14.1 application is slower, that its timing deltas generalize to another screen, that the non-memoized render/CPU multiplier is universal, that lanes were independently varied, or that the diagnostic intervention is safe to ship.

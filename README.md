# Apollo / React commit scheduling lab

[Run the benchmark in your browser](https://superliaye.github.io/apollo-react-commit-benchmark/)

This is a small, product-independent reproduction of a React commit-scheduling difference between Apollo Client 3.6.9 and 3.14.1.

A **component render** is one call of a React function while React calculates the next UI. A **React commit** is the later boundary where React applies one completed render result to the DOM. Many component renders can belong to one commit.

With eight mounted `useQuery` consumers observing one cache update, the reviewed reference run produced:

| Experiment arm | React commits | Subscriber renders | Final state |
| --- | ---: | ---: | --- |
| Apollo 3.6.9 unchanged | 2 | 16 | Identical |
| Apollo 3.14.1 unchanged | 16 | 72 | Identical |
| Apollo 3.14.1 with diagnostic batching | 2 | 16 | Identical |

The deterministic result is the commit pattern and intermediate state progression—not the exact millisecond timing, which varies by machine.

At eight subscribers, `2 / 16 / 2` has a concrete meaning: 3.6.9 and diagnostic 3.14.1 each make one commit that updates all eight query consumers, then one commit for their combined parent-state update. Stock 3.14.1 instead alternates one query-consumer commit and one parent-state commit eight times.

## What ordinary code the benchmark represents

Several mounted components call `useQuery` for the same query. A result that is already available is written to Apollo's in-memory cache. Each component renders real DOM rows, reads its committed layout in `useLayoutEffect`, and publishes derived state to a shared parent.

```tsx
function ResultPanel() {
  const { data } = useQuery(SHARED_ITEM, { fetchPolicy: "cache-only" });

  useLayoutEffect(() => {
    publishMeasuredWidth(ref.current.offsetWidth);
  }, [data]);

  return <ResultRows data={data} ref={ref} />;
}

// The result is already available; network time is not measured.
client.cache.writeQuery({ query: SHARED_ITEM, data: nextResult });
```

The default suite mounts 1, 2, 4, and 8 subscribers, renders 40 DOM rows per subscriber, and runs 96 measured samples in mirrored `ABCCBA` / `CBAABC` order after discarded warmups.

## What is measured

The clock starts immediately before one `cache.writeQuery` and includes:

- Apollo cache publication and observer delivery;
- React rendering and DOM commits;
- real layout effects and geometry reads;
- derived parent-state updates;
- completion through two animation frames after the final commit.

It excludes network time, server time, application-specific logic, and synthetic CPU loops. React Profiler commit events, exact observer counts, task order, snapshots, and final values are all checked. A run fails unless every invariant passes.

## Why the versions differ in this scenario

React **lanes** are its internal priority queues for pending updates. Apollo Client 3.6.9 routes a delivered query result through an ordinary local state setter. In this tested outside-event context, React assigns ordinary `DefaultLane` priority, allowing compatible pending work to combine before a commit.

Apollo Client 3.14.1 routes it through the `useSyncExternalStore` change callback—React's consistency path for data owned outside React, such as Apollo's query store. React 18.3.1 explicitly gives that update `SyncLane`, its synchronous priority. In this reproduction, each mounted `useQuery` owns one watched query object, so eight consumers schedule eight separate zero-delay tasks (later browser event-loop turns). React can synchronously commit one delivery before the next task starts.

The behavior change came from [Apollo PR #11083](https://github.com/apollographql/apollo-client/pull/11083), which fixed an update-ordering problem. Blindly restoring the old setter could reintroduce that correctness bug.

The third arm is a causal diagnostic: it preserves all values and their order but drains pending React-facing observer callbacks in one shared task. It is **not a production-ready fix**. It depends on Apollo private objects and adds queueing delay.

## Run locally

Install [Bun](https://bun.sh/), then:

```bash
bun run check
bun run dev
```

Open the printed local URL and press **Run proof**. The first run downloads exact Apollo and React packages from [esm.sh](https://esm.sh/), so an internet connection is required.

`bun run check` rebuilds the committed browser bundle and audits required sections, glossary links, benchmark controls, and public-content constraints.

## Public source trail

- [Apollo 3.6.9 local state setter](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L68-L77)
- [Apollo 3.6.9 subscription path](https://github.com/apollographql/apollo-client/blob/v3.6.9/src/react/hooks/useQuery.ts#L137-L160)
- [Apollo 3.14.1 passes the store-change handler](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L415-L450)
- [Apollo 3.14.1 invokes it from `setResult`](https://github.com/apollographql/apollo-client/blob/v3.14.1/src/react/hooks/useQuery.ts#L688-L719)
- [React 18.3.1 external-store updates use `SyncLane`](https://github.com/facebook/react/blob/v18.3.1/packages/react-reconciler/src/ReactFiberHooks.old.js#L1478-L1506)
- [Apollo issue #10364: duplicate query subscribers and commits](https://github.com/apollographql/apollo-client/issues/10364)

## Repository map

- `index.html` — newcomer-oriented explanation and live runner
- `src/benchmark.ts` — benchmark, instrumentation, validation, and result rendering
- `src/shared-observer-delivery-task-patch.ts` — diagnostic intervention
- `benchmark.js` — committed browser bundle produced by Bun
- `results/reference-run.json` — full reviewed 96-sample reference run
- `scripts/check-content.ts` — build/content audit used locally and by Pages deployment

## Scope

This benchmark establishes a reproducible mechanism for this query-subscriber shape. It does not claim every Apollo 3.14.1 application is slower, that timing deltas generalize to other screens, or that the diagnostic intervention is safe to ship.

// src/shared-observer-delivery-task-patch.ts
var installApollo314SharedObserverDeliveryTaskPatch = (client) => {
  if (client.version !== "3.14.1") {
    throw new Error(`The shared-delivery diagnostic patch only supports Apollo 3.14.1, received ${client.version}`);
  }
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const diagnostics = {
    batches: 0,
    delivered: 0,
    maxDeliveriesPerBatch: 0,
    queued: 0
  };
  const schedulersByQueryManager = new WeakMap;
  const activeSchedulers = new Set;
  const originalObserverNextFunctions = new Map;
  const originalObserverSetAddFunctions = new Map;
  const instrumentedObservableQueries = new WeakSet;
  const getScheduler = (queryManager) => {
    const existing = schedulersByQueryManager.get(queryManager);
    if (existing)
      return existing;
    const created = { pending: [] };
    schedulersByQueryManager.set(queryManager, created);
    activeSchedulers.add(created);
    return created;
  };
  const flush = (scheduler) => {
    scheduler.timer = undefined;
    const pending = scheduler.pending.splice(0);
    if (pending.length === 0)
      return;
    diagnostics.batches += 1;
    diagnostics.maxDeliveriesPerBatch = Math.max(diagnostics.maxDeliveriesPerBatch, pending.length);
    let firstError;
    for (const delivery of pending) {
      try {
        delivery.originalNext.call(delivery.thisArgument ?? delivery.observer, delivery.value);
        diagnostics.delivered += 1;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (scheduler.pending.length > 0 && scheduler.timer === undefined) {
      scheduler.timer = originalSetTimeout(() => flush(scheduler), 0);
    }
    if (firstError !== undefined) {
      originalSetTimeout(() => {
        throw firstError;
      }, 0);
    }
  };
  const instrumentObserver = (observable, observer) => {
    if (originalObserverNextFunctions.has(observer) || typeof observer.next !== "function")
      return;
    const originalNext = observer.next;
    originalObserverNextFunctions.set(observer, originalNext);
    observer.next = function queueObserverDelivery(value) {
      diagnostics.queued += 1;
      const scheduler = getScheduler(observable.queryManager);
      scheduler.pending.push({
        observer,
        originalNext,
        thisArgument: this,
        value
      });
      if (scheduler.timer === undefined) {
        scheduler.timer = originalSetTimeout(() => flush(scheduler), 0);
      }
    };
  };
  const instrumentObservableQuery = (observable) => {
    if (instrumentedObservableQueries.has(observable))
      return;
    instrumentedObservableQueries.add(observable);
    const observerSet = observable.observers;
    if (!originalObserverSetAddFunctions.has(observerSet)) {
      const originalAdd = observerSet.add;
      originalObserverSetAddFunctions.set(observerSet, originalAdd);
      observerSet.add = function addInstrumentedObserver(observer) {
        instrumentObserver(observable, observer);
        return originalAdd.call(this, observer);
      };
    }
    for (const observer of observerSet)
      instrumentObserver(observable, observer);
  };
  for (const observable of client.getObservableQueries("all").values()) {
    instrumentObservableQuery(observable);
  }
  const originalWatchQuery = client.watchQuery;
  if (typeof originalWatchQuery === "function") {
    client.watchQuery = function watchInstrumentedQuery(options) {
      const observable = originalWatchQuery.call(this, options);
      instrumentObservableQuery(observable);
      return observable;
    };
  }
  return {
    diagnostics,
    restore: () => {
      for (const scheduler of activeSchedulers) {
        if (scheduler.timer !== undefined)
          globalThis.clearTimeout(scheduler.timer);
        if (scheduler.pending.length > 0)
          flush(scheduler);
      }
      for (const [observer, originalNext] of originalObserverNextFunctions)
        observer.next = originalNext;
      for (const [observerSet, originalAdd] of originalObserverSetAddFunctions)
        observerSet.add = originalAdd;
      if (typeof originalWatchQuery === "function")
        client.watchQuery = originalWatchQuery;
      activeSchedulers.clear();
    }
  };
};

// src/benchmark.ts
var benchmarkArms = [
  {
    id: "apollo-369-stock",
    label: "Apollo 3.6.9 stock",
    version: "3.6.9",
    sharedObserverDeliveryTaskPatch: false
  },
  {
    id: "apollo-314-stock",
    label: "Apollo 3.14.1 stock",
    version: "3.14.1",
    sharedObserverDeliveryTaskPatch: false
  },
  {
    id: "apollo-314-shared-delivery-patch",
    label: "Apollo 3.14.1 + diagnostic batching",
    version: "3.14.1",
    sharedObserverDeliveryTaskPatch: true
  }
];
var apolloUrls = {
  "3.6.9": "https://esm.sh/@apollo/client@3.6.9?bundle&external=react&target=es2022",
  "3.14.1": "https://esm.sh/@apollo/client@3.14.1?bundle&external=react&target=es2022"
};
var selectedReactRuntime = window.__APOLLO_REACT_BENCHMARK_RUNTIME__;
if (!selectedReactRuntime) {
  throw new Error("React runtime configuration was not installed before the benchmark module loaded");
}
var expectedReactVersion = selectedReactRuntime.reactVersion;
var expectedReactDomProfilingVersion = selectedReactRuntime.expectedReactDomVersion;
var runtimeCache = new Map;
var loadApollo = async (version) => {
  const cached = runtimeCache.get(version);
  if (cached)
    return cached;
  const runtime = await import(apolloUrls[version]);
  runtimeCache.set(version, runtime);
  return runtime;
};
var reactSpecifier = "react";
var reactDomSpecifier = "react-dom/profiling";
var react = await import(reactSpecifier);
var reactDom = await import(reactDomSpecifier);
var nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
var delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
var settlePaint = async () => {
  await nextFrame();
  await nextFrame();
};
var mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
var percentile = (values, probability) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.round((sorted.length - 1) * probability);
  return sorted[index];
};
var valuesToSnapshot = (values) => values.map((value) => value === null ? "-" : String(value)).join("");
var dedupeAdjacent = (values) => values.filter((value, index) => index === 0 || value !== values[index - 1]);
var arraysEqual = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
var allValuesEqual = (values, expected) => values.every((value) => value === expected);
var updatedSubscriberCount = (snapshot) => [...snapshot].filter((value) => value === "1").length;
var timelineToken = (event) => {
  switch (event.type) {
    case "notification-start":
      return `S${event.notificationIndex}`;
    case "notification-end":
      return `E${event.notificationIndex}`;
    case "observer-next-start":
      return `OS${event.observerIndex}`;
    case "observer-next-end":
      return `OE${event.observerIndex}`;
    case "after-notification-microtask":
      return `M${event.notificationIndex}`;
    case "profiler-commit":
      return "C";
  }
};
var expectedTimelineTokens = (arm, subscriberCount) => {
  const observerTokens = Array.from({ length: subscriberCount }, (_, index) => {
    const observerIndex = index + 1;
    return [`OS${observerIndex}`, `OE${observerIndex}`];
  });
  if (arm === "apollo-369-stock") {
    return Array.from({ length: subscriberCount }, (_, index) => [
      `S${index + 1}`,
      `E${index + 1}`,
      ...observerTokens[index],
      `M${index + 1}`
    ]).flat().concat("C", "C");
  }
  if (arm === "apollo-314-stock") {
    return Array.from({ length: subscriberCount }, (_, index) => [
      `S${index + 1}`,
      `E${index + 1}`,
      ...observerTokens[index],
      `M${index + 1}`,
      "C",
      "C"
    ]).flat();
  }
  return Array.from({ length: subscriberCount }, (_, index) => [
    `S${index + 1}`,
    `E${index + 1}`,
    `M${index + 1}`
  ]).flat().concat(`S${subscriberCount + 1}`, ...observerTokens.flat(), `E${subscriberCount + 1}`, "C", "C", `M${subscriberCount + 1}`);
};
var waitForCondition = async (condition, description) => {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
};
var runSample = async (arm, config, subscriberCount, block, position, order) => {
  const apollo = await loadApollo(arm.version);
  const query = apollo.gql('query SharedItem { benchmarkItem(id: "shared") { id value __typename } }');
  const cache = new apollo.InMemoryCache({ addTypename: true });
  cache.writeQuery({
    query,
    data: { benchmarkItem: { __typename: "BenchmarkItem", id: "shared", value: 0 } }
  });
  const client = new apollo.ApolloClient({ cache, link: apollo.ApolloLink.empty() });
  const mount = document.createElement("div");
  mount.className = "benchmark-mount";
  document.body.appendChild(mount);
  const root = reactDom.createRoot(mount);
  const observedValues = Array(subscriberCount).fill(null);
  const subscriberRenderCalls = Array(subscriberCount).fill(0);
  const subscribersWithPassiveEffects = new Set;
  const profilerCommits = [];
  const layoutPublications = [];
  const timeline = [];
  let measurementActive = false;
  let measuredCacheWrites = 0;
  let writeStartedAt = 0;
  let writeFinishedAt = 0;
  let finalCommitAt = 0;
  let renderedDerivedVersion = 0;
  let derivedParentRenderCalls = 0;
  let derivedLayoutEffectCount = 0;
  let geometryReadCount = 0;
  let geometryReadMillis = 0;
  let geometryChecksum = 0;
  const restoreObserverNextFunctions = [];
  const restoreApolloPatches = [];
  let observerDeliveryPatchDiagnostics = {
    batches: 0,
    delivered: 0,
    maxDeliveriesPerBatch: 0,
    queued: 0
  };
  let resolveComplete;
  const completion = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const measureGeometry = () => {
    const startedAt = performance.now();
    const bounds = mount.getBoundingClientRect();
    geometryChecksum += bounds.width + bounds.height + mount.scrollWidth;
    const duration = performance.now() - startedAt;
    geometryReadCount += 1;
    geometryReadMillis += duration;
    return duration;
  };
  const QuerySubscriber = ({
    publishDerivedState,
    subscriberIndex
  }) => {
    const result = apollo.useQuery(query, { fetchPolicy: "cache-only" });
    const observedValue = result.data?.benchmarkItem?.value ?? null;
    observedValues[subscriberIndex] = observedValue;
    if (measurementActive)
      subscriberRenderCalls[subscriberIndex] += 1;
    react.useEffect(() => {
      subscribersWithPassiveEffects.add(subscriberIndex);
      return () => subscribersWithPassiveEffects.delete(subscriberIndex);
    }, []);
    react.useLayoutEffect(() => {
      if (!measurementActive)
        return;
      const geometryReadDuration = measureGeometry();
      const now = performance.now();
      layoutPublications.push({
        kind: "query-result",
        subscriberIndex,
        derivedVersion: renderedDerivedVersion,
        elapsedMillis: now - writeStartedAt,
        snapshot: valuesToSnapshot(observedValues),
        geometryReadMillis: geometryReadDuration
      });
      publishDerivedState();
    }, [observedValue]);
    const rows = Array.from({ length: config.renderedRowsPerSubscriber }, (_, rowIndex) => react.createElement("div", { className: "benchmark-row", key: rowIndex }, react.createElement("span", { className: "benchmark-cell benchmark-cell-name" }, `task-${rowIndex}`), react.createElement("span", { className: "benchmark-cell" }, `subscriber-${subscriberIndex}`), react.createElement("span", { className: "benchmark-cell" }, observedValue === 1 ? "ready" : "loading"), react.createElement("span", { className: "benchmark-cell benchmark-cell-value" }, String(observedValue))));
    return react.createElement("section", {
      className: "benchmark-subscriber",
      "data-subscriber": subscriberIndex,
      style: { paddingInlineStart: observedValue === 1 ? "2px" : "0px" }
    }, ...rows);
  };
  const BenchmarkApplication = () => {
    const [derivedVersion, setDerivedVersion] = react.useState(0);
    renderedDerivedVersion = derivedVersion;
    if (measurementActive)
      derivedParentRenderCalls += 1;
    react.useLayoutEffect(() => {
      if (!measurementActive || derivedVersion === 0)
        return;
      derivedLayoutEffectCount += 1;
      const geometryReadDuration = measureGeometry();
      const now = performance.now();
      layoutPublications.push({
        kind: "derived-parent-state",
        derivedVersion,
        elapsedMillis: now - writeStartedAt,
        snapshot: valuesToSnapshot(observedValues),
        geometryReadMillis: geometryReadDuration
      });
      if (derivedVersion === subscriberCount && allValuesEqual(observedValues, 1) && finalCommitAt === 0) {
        finalCommitAt = now;
        resolveComplete?.();
      }
    }, [derivedVersion]);
    return react.createElement("div", {
      className: "benchmark-application",
      "data-derived-version": derivedVersion
    }, react.createElement("header", { className: "benchmark-summary" }, `Processed ${derivedVersion} of ${subscriberCount} query publications`), ...Array.from({ length: subscriberCount }, (_, subscriberIndex) => react.createElement(QuerySubscriber, {
      key: subscriberIndex,
      publishDerivedState: () => setDerivedVersion((previous) => previous + 1),
      subscriberIndex
    })));
  };
  const onRender = (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    if (!measurementActive)
      return;
    timeline.push({
      type: "profiler-commit",
      elapsedMillis: commitTime - writeStartedAt,
      snapshot: valuesToSnapshot(observedValues),
      derivedVersion: renderedDerivedVersion
    });
    profilerCommits.push({
      phase,
      actualDurationMillis: actualDuration,
      baseDurationMillis: baseDuration,
      startTimeMillis: startTime,
      commitTimeMillis: commitTime,
      elapsedMillis: commitTime - writeStartedAt,
      snapshot: valuesToSnapshot(observedValues),
      derivedVersion: renderedDerivedVersion
    });
  };
  root.render(react.createElement(apollo.ApolloProvider, { client }, react.createElement(react.Profiler, { id: "apollo-commit-proof", onRender }, react.createElement(BenchmarkApplication))));
  let zeroDelayHostTasksScheduled = 0;
  let logicalNotifyCalls = 0;
  try {
    await waitForCondition(() => allValuesEqual(observedValues, 0) && subscribersWithPassiveEffects.size === subscriberCount, "the baseline query values and subscriptions");
    await delay(30);
    await settlePaint();
    const baselineSnapshot = valuesToSnapshot(observedValues);
    const activeObservables = [...client.getObservableQueries("active").values()];
    let observerIndex = 0;
    activeObservables.forEach((observable) => {
      observable.observers.forEach((observer) => {
        const originalNext = observer.next;
        if (!originalNext)
          return;
        observerIndex += 1;
        const currentObserverIndex = observerIndex;
        observer.next = function instrumentedObserverNext(value) {
          if (measurementActive) {
            logicalNotifyCalls += 1;
            timeline.push({
              type: "observer-next-start",
              observerIndex: currentObserverIndex,
              browserEventType: window.event?.type ?? null,
              elapsedMillis: performance.now() - writeStartedAt,
              snapshot: valuesToSnapshot(observedValues)
            });
          }
          try {
            originalNext.call(this, value);
          } finally {
            if (measurementActive) {
              timeline.push({
                type: "observer-next-end",
                observerIndex: currentObserverIndex,
                elapsedMillis: performance.now() - writeStartedAt,
                snapshot: valuesToSnapshot(observedValues)
              });
            }
          }
        };
        restoreObserverNextFunctions.push(() => {
          observer.next = originalNext;
        });
      });
    });
    const originalSetTimeout = window.setTimeout;
    const callOriginalSetTimeout = (handler, timeout = 0, ...args) => originalSetTimeout(handler, timeout, ...args);
    window.setTimeout = (handler, timeout = 0, ...args) => {
      if (timeout === 0 && typeof handler === "function") {
        zeroDelayHostTasksScheduled += 1;
        const notificationIndex = zeroDelayHostTasksScheduled;
        const invokeNotification = () => {
          timeline.push({
            type: "notification-start",
            notificationIndex,
            elapsedMillis: performance.now() - writeStartedAt,
            snapshot: valuesToSnapshot(observedValues)
          });
          handler(...args);
          timeline.push({
            type: "notification-end",
            notificationIndex,
            elapsedMillis: performance.now() - writeStartedAt,
            snapshot: valuesToSnapshot(observedValues)
          });
          queueMicrotask(() => {
            timeline.push({
              type: "after-notification-microtask",
              notificationIndex,
              elapsedMillis: performance.now() - writeStartedAt,
              snapshot: valuesToSnapshot(observedValues)
            });
          });
        };
        return callOriginalSetTimeout(invokeNotification, timeout);
      }
      return callOriginalSetTimeout(handler, timeout, ...args);
    };
    if (arm.sharedObserverDeliveryTaskPatch) {
      const patchHandle = installApollo314SharedObserverDeliveryTaskPatch(client);
      observerDeliveryPatchDiagnostics = patchHandle.diagnostics;
      restoreApolloPatches.push(patchHandle.restore);
    }
    measurementActive = true;
    writeStartedAt = performance.now();
    try {
      measuredCacheWrites += 1;
      cache.writeQuery({
        query,
        data: { benchmarkItem: { __typename: "BenchmarkItem", id: "shared", value: 1 } }
      });
      writeFinishedAt = performance.now();
    } finally {
      window.setTimeout = originalSetTimeout;
    }
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        callOriginalSetTimeout(() => reject(new Error("Timed out waiting for the final subscriber commit")), 2000);
      })
    ]);
    await settlePaint();
    const paintedAt = performance.now();
    const finalSnapshot = valuesToSnapshot(observedValues);
    const distinctLayoutSnapshots = dedupeAdjacent(layoutPublications.map((publication) => publication.snapshot));
    const profilerSnapshots = profilerCommits.map((commit) => commit.snapshot);
    const validationErrors = [];
    if (client.version !== arm.version) {
      validationErrors.push(`Expected Apollo ${arm.version}, loaded ${client.version}`);
    }
    if (react.version !== expectedReactVersion || reactDom.version !== expectedReactDomProfilingVersion) {
      validationErrors.push(`Expected React ${expectedReactVersion} and its profiling renderer ${expectedReactDomProfilingVersion}, loaded ${react.version}/${reactDom.version}`);
    }
    if (baselineSnapshot !== "0".repeat(subscriberCount)) {
      validationErrors.push(`Baseline snapshot was ${baselineSnapshot}`);
    }
    if (measuredCacheWrites !== 1) {
      validationErrors.push(`Expected one measured cache write, observed ${measuredCacheWrites}`);
    }
    const expectedHostTaskCount = arm.sharedObserverDeliveryTaskPatch ? subscriberCount + 1 : subscriberCount;
    if (zeroDelayHostTasksScheduled !== expectedHostTaskCount) {
      validationErrors.push(`Expected ${expectedHostTaskCount} zero-delay Apollo host tasks, observed ${zeroDelayHostTasksScheduled}`);
    }
    if (logicalNotifyCalls !== subscriberCount) {
      validationErrors.push(`Expected ${subscriberCount} logical notify calls, observed ${logicalNotifyCalls}`);
    }
    if (arm.sharedObserverDeliveryTaskPatch) {
      if (observerDeliveryPatchDiagnostics.queued !== subscriberCount || observerDeliveryPatchDiagnostics.delivered !== subscriberCount) {
        validationErrors.push(`Expected ${subscriberCount} queued and completed observer deliveries, observed ${observerDeliveryPatchDiagnostics.queued}/${observerDeliveryPatchDiagnostics.delivered}`);
      }
      if (observerDeliveryPatchDiagnostics.batches !== 1 || observerDeliveryPatchDiagnostics.maxDeliveriesPerBatch !== subscriberCount) {
        validationErrors.push(`Expected one delivery batch of ${subscriberCount}, observed ${observerDeliveryPatchDiagnostics.batches} batches with max ${observerDeliveryPatchDiagnostics.maxDeliveriesPerBatch}`);
      }
    }
    if (!allValuesEqual(observedValues, 1)) {
      validationErrors.push(`Final snapshot was ${finalSnapshot}`);
    }
    if (renderedDerivedVersion !== subscriberCount) {
      validationErrors.push(`Expected derived version ${subscriberCount}, observed ${renderedDerivedVersion}`);
    }
    if (profilerCommits.length === 0) {
      validationErrors.push("React Profiler captured no measured commits");
    }
    if (!profilerCommits.every((commit) => commit.phase === "update" || commit.phase === "nested-update")) {
      validationErrors.push("A measured Profiler event was neither an update nor a nested update");
    }
    const distinctProfilerSnapshots = dedupeAdjacent(profilerSnapshots);
    if (!arraysEqual(distinctProfilerSnapshots, distinctLayoutSnapshots)) {
      validationErrors.push(`Distinct Profiler snapshots ${JSON.stringify(distinctProfilerSnapshots)} did not match layout-effect snapshots ${JSON.stringify(distinctLayoutSnapshots)}`);
    }
    const expectedSubscriberRenderCalls = arm.id === "apollo-314-stock" ? subscriberCount + 1 : 2;
    if (!subscriberRenderCalls.every((renderCalls) => renderCalls === expectedSubscriberRenderCalls)) {
      validationErrors.push(`Subscriber render calls were ${JSON.stringify(subscriberRenderCalls)}`);
    }
    const queryLayoutPublications = layoutPublications.filter((publication) => publication.kind === "query-result");
    if (queryLayoutPublications.length !== subscriberCount) {
      validationErrors.push(`Expected ${subscriberCount} query-result layout publications, observed ${queryLayoutPublications.length}`);
    }
    const expectedDerivedLayoutEffectCount = arm.id === "apollo-314-stock" ? subscriberCount : 1;
    if (derivedLayoutEffectCount !== expectedDerivedLayoutEffectCount) {
      validationErrors.push(`Expected ${expectedDerivedLayoutEffectCount} derived layout effects, observed ${derivedLayoutEffectCount}`);
    }
    const expectedGeometryReadCount = subscriberCount + expectedDerivedLayoutEffectCount;
    if (geometryReadCount !== expectedGeometryReadCount) {
      validationErrors.push(`Expected ${expectedGeometryReadCount} geometry reads, observed ${geometryReadCount}`);
    }
    const expectedProfilerCommitCount = arm.id === "apollo-314-stock" ? subscriberCount * 2 : 2;
    if (profilerCommits.length !== expectedProfilerCommitCount) {
      validationErrors.push(`Expected ${expectedProfilerCommitCount} commits, observed ${profilerCommits.length}`);
    }
    const expectedUpdatedCounts = arm.id === "apollo-314-stock" ? Array.from({ length: subscriberCount }, (_, index) => index + 1) : [subscriberCount];
    const observedUpdatedCounts = distinctProfilerSnapshots.map(updatedSubscriberCount);
    if (!arraysEqual(observedUpdatedCounts.map(String), expectedUpdatedCounts.map(String))) {
      validationErrors.push(`Expected updated-subscriber progression ${JSON.stringify(expectedUpdatedCounts)}, observed ${JSON.stringify(observedUpdatedCounts)}`);
    }
    const observedTimelineTokens = timeline.map(timelineToken);
    const requiredTimelineTokens = expectedTimelineTokens(arm.id, subscriberCount);
    if (!arraysEqual(observedTimelineTokens, requiredTimelineTokens)) {
      validationErrors.push(`Expected task timeline ${JSON.stringify(requiredTimelineTokens)}, observed ${JSON.stringify(observedTimelineTokens)}`);
    }
    const observerStartEvents = timeline.filter((event) => event.type === "observer-next-start");
    if (observerStartEvents.length !== subscriberCount) {
      validationErrors.push(`Expected ${subscriberCount} React-facing observer deliveries, observed ${observerStartEvents.length}`);
    }
    if (observerStartEvents.some((event) => event.browserEventType !== null)) {
      validationErrors.push(`Expected observer delivery outside a browser event, observed ${JSON.stringify(observerStartEvents.map((event) => event.browserEventType))}`);
    }
    measurementActive = false;
    return {
      arm: arm.id,
      armLabel: arm.label,
      requestedVersion: arm.version,
      actualVersion: client.version,
      reactVersion: react.version,
      reactDomVersion: reactDom.version,
      block,
      position,
      order,
      subscriberCount,
      measuredCacheWrites,
      zeroDelayHostTasksScheduled,
      logicalNotifyCalls,
      observerDeliveryBatches: observerDeliveryPatchDiagnostics.batches,
      observerDeliveriesQueued: observerDeliveryPatchDiagnostics.queued,
      observerDeliveriesCompleted: observerDeliveryPatchDiagnostics.delivered,
      maxObserverDeliveriesPerBatch: observerDeliveryPatchDiagnostics.maxDeliveriesPerBatch,
      subscriberRenderCalls,
      derivedParentRenderCalls,
      derivedLayoutEffectCount,
      profilerCommitCount: profilerCommits.length,
      profilerCommits,
      layoutPublications,
      timeline,
      distinctLayoutSnapshots,
      baselineSnapshot,
      finalSnapshot,
      finalChecksum: observedValues.reduce((total, value) => total + (value ?? 0), 0),
      finalDerivedVersion: renderedDerivedVersion,
      geometryReadCount,
      geometryReadMillis,
      geometryChecksum,
      cacheWriteMillis: writeFinishedAt - writeStartedAt,
      resultToFinalCommitMillis: finalCommitAt - writeStartedAt,
      resultToPaintMillis: paintedAt - writeStartedAt,
      validationErrors
    };
  } finally {
    measurementActive = false;
    restoreApolloPatches.forEach((restore) => restore());
    restoreObserverNextFunctions.forEach((restore) => restore());
    root.unmount();
    client.stop();
    mount.remove();
  }
};
var summarize = (config, samples) => {
  const summary = config.subscriberCounts.flatMap((subscriberCount) => benchmarkArms.map((arm) => {
    const rows = samples.filter((sample) => sample.subscriberCount === subscriberCount && sample.arm === arm.id);
    const renderCpu = rows.map((sample) => sample.profilerCommits.reduce((total, commit) => total + commit.actualDurationMillis, 0));
    return {
      arm: arm.id,
      armLabel: arm.label,
      subscriberCount,
      samples: rows.length,
      validSamples: rows.filter((sample) => sample.validationErrors.length === 0).length,
      hostTasksMean: mean(rows.map((sample) => sample.zeroDelayHostTasksScheduled)),
      logicalNotificationsMean: mean(rows.map((sample) => sample.logicalNotifyCalls)),
      observerDeliveryBatchesMean: mean(rows.map((sample) => sample.observerDeliveryBatches)),
      maxObserverDeliveriesPerBatchMean: mean(rows.map((sample) => sample.maxObserverDeliveriesPerBatch)),
      commitsMean: mean(rows.map((sample) => sample.profilerCommitCount)),
      commitsMin: Math.min(...rows.map((sample) => sample.profilerCommitCount)),
      commitsMax: Math.max(...rows.map((sample) => sample.profilerCommitCount)),
      subscriberRendersMean: mean(rows.map((sample) => sample.subscriberRenderCalls.reduce((total, count) => total + count, 0))),
      derivedLayoutEffectsMean: mean(rows.map((sample) => sample.derivedLayoutEffectCount)),
      geometryReadMeanMillis: mean(rows.map((sample) => sample.geometryReadMillis)),
      renderCpuMeanMillis: mean(renderCpu),
      resultToCommitP50Millis: percentile(rows.map((sample) => sample.resultToFinalCommitMillis), 0.5),
      resultToCommitP90Millis: percentile(rows.map((sample) => sample.resultToFinalCommitMillis), 0.9),
      resultToPaintP50Millis: percentile(rows.map((sample) => sample.resultToPaintMillis), 0.5),
      resultToPaintP90Millis: percentile(rows.map((sample) => sample.resultToPaintMillis), 0.9)
    };
  }));
  const matchingSamples = (arm, subscriberCount, commits) => samples.filter((sample) => sample.arm === arm && sample.subscriberCount === subscriberCount && sample.validationErrors.length === 0 && sample.profilerCommitCount === commits);
  const sampleCountPerArmAndSize = config.blocks * 2;
  const allSamplesValid = samples.every((sample) => sample.validationErrors.length === 0);
  const singleSubscriberControlPassed = benchmarkArms.every((arm) => matchingSamples(arm.id, 1, 2).length === sampleCountPerArmAndSize);
  const multiSubscriberCounts = config.subscriberCounts.filter((subscriberCount) => subscriberCount > 1);
  const stock369Coalesced = multiSubscriberCounts.every((subscriberCount) => matchingSamples("apollo-369-stock", subscriberCount, 2).length === sampleCountPerArmAndSize);
  const stock314Fragmented = multiSubscriberCounts.every((subscriberCount) => matchingSamples("apollo-314-stock", subscriberCount, subscriberCount * 2).length === sampleCountPerArmAndSize);
  const patched314Restored = multiSubscriberCounts.every((subscriberCount) => matchingSamples("apollo-314-shared-delivery-patch", subscriberCount, 2).length === sampleCountPerArmAndSize);
  const logicalNotificationsMatchedSubscribers = samples.every((sample) => sample.logicalNotifyCalls === sample.subscriberCount);
  const hostTaskCountsMatched = samples.every((sample) => sample.zeroDelayHostTasksScheduled === (sample.arm === "apollo-314-shared-delivery-patch" ? sample.subscriberCount + 1 : sample.subscriberCount));
  const observerDeliveriesPreserved = samples.every((sample) => sample.arm !== "apollo-314-shared-delivery-patch" || sample.observerDeliveriesQueued === sample.subscriberCount && sample.observerDeliveriesCompleted === sample.subscriberCount && sample.observerDeliveryBatches === 1 && sample.maxObserverDeliveriesPerBatch === sample.subscriberCount);
  const realReactWorkMatched = samples.every((sample) => sample.subscriberRenderCalls.reduce((total, count) => total + count, 0) === (sample.arm === "apollo-314-stock" ? sample.subscriberCount * (sample.subscriberCount + 1) : sample.subscriberCount * 2));
  const allTaskTimelinesExact = samples.every((sample) => arraysEqual(sample.timeline.map(timelineToken), expectedTimelineTokens(sample.arm, sample.subscriberCount)));
  const proofConditions = [
    {
      description: "Every sample loaded the requested versions, reached identical final data, and passed every invariant.",
      passed: allSamplesValid,
      evidence: `${samples.filter((sample) => sample.validationErrors.length === 0).length}/${samples.length} valid samples`
    },
    {
      description: "One subscriber is a negative control: every arm has one query commit plus one derived-state commit.",
      passed: singleSubscriberControlPassed,
      evidence: `${sampleCountPerArmAndSize} samples per arm at one subscriber`
    },
    {
      description: "Every arm preserves one logical Apollo notification per query subscriber.",
      passed: logicalNotificationsMatchedSubscribers,
      evidence: "logical notify count equals subscriber count in every sample"
    },
    {
      description: "The scoped 3.14.1 patch preserves all observer deliveries while draining them in one shared task.",
      passed: hostTaskCountsMatched,
      evidence: "the patched arm retains N Apollo notification tasks and adds one shared delivery task"
    },
    {
      description: "The shared delivery task neither drops nor deduplicates subscriber values.",
      passed: observerDeliveriesPreserved,
      evidence: "queued = delivered = subscriber count, in one batch, for every patched sample"
    },
    {
      description: "Every timer, React-facing observer delivery, microtask checkpoint, and commit followed the source-derived task timeline.",
      passed: allTaskTimelinesExact,
      evidence: "observer delivery ran after its timer callback with no active browser event in every sample"
    },
    {
      description: "Stock 3.6.9 uses one query commit and one derived-state commit.",
      passed: stock369Coalesced,
      evidence: `tested subscriber counts: ${multiSubscriberCounts.join(", ")}`
    },
    {
      description: "Stock 3.14.1 repeats both the query and derived-state commits for each subscriber.",
      passed: stock314Fragmented,
      evidence: `tested subscriber counts: ${multiSubscriberCounts.join(", ")}`
    },
    {
      description: "The scoped 3.14.1 observer-delivery patch restores the two-commit result.",
      passed: patched314Restored,
      evidence: `tested subscriber counts: ${multiSubscriberCounts.join(", ")}`
    },
    {
      description: "Fragmented query commits cause real repeated React component rendering in the derived parent tree.",
      passed: realReactWorkMatched,
      evidence: "where N is subscriber count, stock 3.14.1 renders N(N+1) subscriber subtrees; 3.6.9 and diagnostic 3.14.1 render 2N"
    }
  ];
  return {
    generatedAt: new Date().toISOString(),
    config,
    environment: {
      selectedReactMajor: selectedReactRuntime.major,
      selectedReactLabel: selectedReactRuntime.label,
      react: react.version,
      reactDom: reactDom.version,
      userAgent: navigator.userAgent
    },
    proofPassed: proofConditions.every((condition) => condition.passed),
    proofConditions,
    summary,
    samples
  };
};
var headlineTargets = [
  ["apollo-369-stock", "#headline-369"],
  ["apollo-314-stock", "#headline-314"],
  ["apollo-314-shared-delivery-patch", "#headline-patched"]
];
var initialTraceStripsMarkup = document.querySelector("#trace-strips")?.innerHTML ?? "";
var pendingVerdict = "Run the benchmark. A result passes only if every required condition holds.";
var reactVersionSelect = document.querySelector("#react-version");
if (reactVersionSelect) {
  let runtimeSwitchPending = false;
  window.addEventListener("pageshow", () => {
    reactVersionSelect.value = selectedReactRuntime.major;
    if (!runtimeSwitchPending)
      return;
    runtimeSwitchPending = false;
    reactVersionSelect.disabled = false;
    const runButton = document.querySelector("#run");
    if (runButton)
      runButton.disabled = false;
    const status = document.querySelector("#status");
    if (status) {
      status.textContent = `${selectedReactRuntime.requestWarning ? `${selectedReactRuntime.requestWarning} ` : ""}Ready. ${selectedReactRuntime.label} selected; the runtime change was canceled.`;
    }
  });
  reactVersionSelect.addEventListener("change", () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("react", reactVersionSelect.value);
    for (const [parameter, selector] of [
      ["blocks", "#blocks"],
      ["subscribers", "#subscribers"],
      ["rows", "#rows"]
    ]) {
      const control = document.querySelector(selector);
      if (control)
        nextUrl.searchParams.set(parameter, control.value);
    }
    reactVersionSelect.disabled = true;
    const runButton = document.querySelector("#run");
    if (runButton)
      runButton.disabled = true;
    const status = document.querySelector("#status");
    if (status)
      status.textContent = `Reloading with React ${reactVersionSelect.value}…`;
    runtimeSwitchPending = true;
    window.location.assign(nextUrl);
  });
}
var resetLiveResults = (headlineContextText, traceProvenanceText) => {
  for (const [, selector] of headlineTargets) {
    const target = document.querySelector(selector);
    if (target)
      target.textContent = "—";
  }
  const headlineContext = document.querySelector("#headline-context");
  if (headlineContext)
    headlineContext.textContent = headlineContextText;
  const verdict = document.querySelector("#verdict");
  if (verdict) {
    verdict.className = "verdict pending";
    verdict.textContent = pendingVerdict;
  }
  const conditions = document.querySelector("#proof-conditions");
  if (conditions)
    conditions.replaceChildren();
  const environment = document.querySelector("#environment");
  if (environment)
    environment.replaceChildren();
  const summaryBody = document.querySelector("#summary-body");
  if (summaryBody) {
    summaryBody.innerHTML = '<tr class="placeholder"><td colspan="7">Run the benchmark to populate live results.</td></tr>';
  }
  const advancedSummaryBody = document.querySelector("#advanced-summary-body");
  if (advancedSummaryBody) {
    advancedSummaryBody.innerHTML = '<tr class="placeholder"><td colspan="11">Run the benchmark to populate live results.</td></tr>';
  }
  const traceStrips = document.querySelector("#trace-strips");
  if (traceStrips)
    traceStrips.innerHTML = initialTraceStripsMarkup;
  const traceBody = document.querySelector("#trace-body");
  if (traceBody) {
    traceBody.innerHTML = '<tr class="placeholder"><td colspan="5">Run the benchmark to populate the trace.</td></tr>';
  }
  const traceProvenance = document.querySelector("#trace-provenance");
  if (traceProvenance)
    traceProvenance.textContent = traceProvenanceText;
  const raw = document.querySelector("#raw-result");
  if (raw)
    raw.textContent = "Run the benchmark to generate JSON.";
  window.__APOLLO_REACT_RENDER_RESULTS__ = undefined;
};
var renderResult = (result) => {
  const largestSubscriberCount = Math.max(...result.config.subscriberCounts);
  for (const [arm, selector] of headlineTargets) {
    const row = result.summary.find((candidate) => candidate.arm === arm && candidate.subscriberCount === largestSubscriberCount);
    const target = document.querySelector(selector);
    if (row && target) {
      target.textContent = Number.isInteger(row.commitsMean) ? row.commitsMean.toFixed(0) : row.commitsMean.toFixed(1);
    }
  }
  const headlineContext = document.querySelector("#headline-context");
  if (headlineContext) {
    headlineContext.textContent = `${largestSubscriberCount} subscribers · ${result.environment.selectedReactLabel} · live run${result.proofPassed ? "" : " · proof failed"}`;
  }
  const verdict = document.querySelector("#verdict");
  if (verdict) {
    verdict.className = result.proofPassed ? "verdict pass" : "verdict fail";
    verdict.textContent = result.proofPassed ? "PASS: all version, delivery-order, final-data, and expected commit-pattern checks passed." : "FAIL: at least one required version, delivery-order, final-data, or commit-pattern check failed.";
  }
  const conditions = document.querySelector("#proof-conditions");
  if (conditions) {
    conditions.innerHTML = result.proofConditions.map((condition) => `<li class="${condition.passed ? "condition-pass" : "condition-fail"}"><strong>${condition.passed ? "PASS" : "FAIL"}</strong> — ${condition.description} <span>${condition.evidence}</span></li>`).join("");
  }
  const summaryBody = document.querySelector("#summary-body");
  if (summaryBody) {
    summaryBody.innerHTML = result.summary.map((row) => `<tr><td>${row.subscriberCount}</td><td>${row.armLabel}</td><td>${row.validSamples}/${row.samples}</td><td>${row.commitsMean.toFixed(1)} (${row.commitsMin}–${row.commitsMax})</td><td>${row.subscriberRendersMean.toFixed(1)}</td><td>${row.resultToCommitP50Millis.toFixed(2)} ms</td><td>${row.resultToPaintP50Millis.toFixed(2)} ms</td></tr>`).join("");
  }
  const advancedSummaryBody = document.querySelector("#advanced-summary-body");
  if (advancedSummaryBody) {
    advancedSummaryBody.innerHTML = result.summary.map((row) => {
      const diagnosticBatchCount = row.arm === "apollo-314-shared-delivery-patch" ? row.observerDeliveryBatchesMean.toFixed(1) : "—";
      const diagnosticBatchSize = row.arm === "apollo-314-shared-delivery-patch" ? row.maxObserverDeliveriesPerBatchMean.toFixed(1) : "—";
      return `<tr><td>${row.subscriberCount}</td><td>${row.armLabel}</td><td>${row.hostTasksMean.toFixed(1)}</td><td>${row.logicalNotificationsMean.toFixed(1)}</td><td>${diagnosticBatchCount}</td><td>${diagnosticBatchSize}</td><td>${row.derivedLayoutEffectsMean.toFixed(1)}</td><td>${row.renderCpuMeanMillis.toFixed(2)} ms</td><td>${row.geometryReadMeanMillis.toFixed(2)} ms</td><td>${row.resultToCommitP90Millis.toFixed(2)} ms</td><td>${row.resultToPaintP90Millis.toFixed(2)} ms</td></tr>`;
    }).join("");
  }
  const representativeSamples = benchmarkArms.map((arm) => result.samples.find((candidate) => candidate.arm === arm.id && candidate.subscriberCount === largestSubscriberCount)).filter((sample) => sample !== undefined);
  const traceStrips = document.querySelector("#trace-strips");
  if (traceStrips) {
    traceStrips.innerHTML = representativeSamples.map((sample) => {
      let previousSnapshot = sample.baselineSnapshot;
      let queryCommitIndex = 0;
      let derivedCommitIndex = 0;
      const hasCombinedCommitPattern = sample.profilerCommitCount === 2;
      const cells = sample.profilerCommits.map((commit) => {
        const isDerivedCommit = commit.snapshot === previousSnapshot;
        previousSnapshot = commit.snapshot;
        if (isDerivedCommit) {
          derivedCommitIndex += 1;
          const label2 = hasCombinedCommitPattern ? "D · combined" : `D${derivedCommitIndex}`;
          return `<span class="commit-cell derived" aria-label="Derived-state commit ${derivedCommitIndex}; snapshot ${commit.snapshot}">${label2}</span>`;
        }
        queryCommitIndex += 1;
        const label = hasCombinedCommitPattern ? `Q · all ${sample.subscriberCount}` : `Q${queryCommitIndex}`;
        return `<span class="commit-cell" aria-label="Query-result commit ${queryCommitIndex}; snapshot ${commit.snapshot}">${label}</span>`;
      }).join("");
      const progression = [sample.baselineSnapshot, ...sample.distinctLayoutSnapshots].join(" → ");
      return `<div class="commit-strip-row"><div class="commit-strip-heading"><strong>${sample.armLabel}</strong><span>${sample.profilerCommitCount} commits</span></div><div class="commit-strip">${cells}</div><p class="trace-explanation">Visible query progression: <code>${progression}</code></p></div>`;
    }).join("");
  }
  const traceProvenance = document.querySelector("#trace-provenance");
  if (traceProvenance) {
    traceProvenance.textContent = `Measured representative samples at ${largestSubscriberCount} subscribers from this browser run.`;
  }
  const traceBody = document.querySelector("#trace-body");
  if (traceBody) {
    traceBody.innerHTML = representativeSamples.flatMap((sample) => {
      return sample.profilerCommits.map((commit, index) => `<tr><td>${sample.armLabel}</td><td>${index + 1}</td><td><code>${commit.snapshot}</code></td><td>${commit.derivedVersion}</td><td>${commit.elapsedMillis.toFixed(2)}</td></tr>`);
    }).join("");
  }
  const environment = document.querySelector("#environment");
  if (environment) {
    environment.textContent = `React ${result.environment.react}; react-dom/profiling ${result.environment.reactDom}; ${result.samples.length} measured samples; generated ${result.generatedAt}.`;
  }
  const raw = document.querySelector("#raw-result");
  if (raw)
    raw.textContent = JSON.stringify(result, null, 2);
};
var parseSubscriberCounts = (value) => {
  const counts = [...new Set(value.split(",").map((part) => Number(part.trim())))].sort((left, right) => left - right);
  if (counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count < 1 || count > 32)) {
    throw new Error("Subscriber counts must be comma-separated integers from 1 to 32");
  }
  if (!counts.includes(1) || !counts.some((count) => count > 1)) {
    throw new Error("Subscriber counts must include 1 and at least one value greater than 1");
  }
  return counts;
};
var runButton = document.querySelector("#run");
runButton?.addEventListener("click", async () => {
  const status = document.querySelector("#status");
  runButton.disabled = true;
  if (reactVersionSelect)
    reactVersionSelect.disabled = true;
  resetLiveResults("run in progress…", "Run in progress. The strips below show the expected eight-subscriber pattern until live data completes.");
  try {
    const config = {
      blocks: Number(document.querySelector("#blocks")?.value ?? "4"),
      subscriberCounts: parseSubscriberCounts(document.querySelector("#subscribers")?.value ?? "1,2,4,8"),
      renderedRowsPerSubscriber: Number(document.querySelector("#rows")?.value ?? "400")
    };
    if (!Number.isInteger(config.blocks) || config.blocks < 2 || config.blocks > 10 || config.blocks % 2 !== 0) {
      throw new Error("Balanced blocks must be an even integer from 2 to 10");
    }
    if (!Number.isInteger(config.renderedRowsPerSubscriber) || config.renderedRowsPerSubscriber < 0 || config.renderedRowsPerSubscriber > 2000) {
      throw new Error("Rows per subscriber must be an integer from 0 to 2000");
    }
    const samples = [];
    const largestSubscriberCount = Math.max(...config.subscriberCounts);
    if (status)
      status.textContent = "Loading exact package versions and running discarded warmups…";
    for (const [index, arm] of benchmarkArms.entries()) {
      await runSample(arm, config, largestSubscriberCount, 0, index + 1, "warmup");
    }
    const oddOrder = [
      "apollo-369-stock",
      "apollo-314-stock",
      "apollo-314-shared-delivery-patch",
      "apollo-314-shared-delivery-patch",
      "apollo-314-stock",
      "apollo-369-stock"
    ];
    const evenOrder = [
      "apollo-314-shared-delivery-patch",
      "apollo-314-stock",
      "apollo-369-stock",
      "apollo-369-stock",
      "apollo-314-stock",
      "apollo-314-shared-delivery-patch"
    ];
    const totalSamples = config.subscriberCounts.length * config.blocks * oddOrder.length;
    let completedSamples = 0;
    for (const subscriberCount of config.subscriberCounts) {
      for (let block = 1;block <= config.blocks; block += 1) {
        const armOrder = block % 2 === 1 ? oddOrder : evenOrder;
        const order = block % 2 === 1 ? "ABCCBA" : "CBAABC";
        for (const [index, armId] of armOrder.entries()) {
          const arm = benchmarkArms.find((candidate) => candidate.id === armId);
          if (!arm)
            throw new Error(`Unknown benchmark arm ${armId}`);
          completedSamples += 1;
          if (status && index === 0 && block === 1) {
            status.textContent = `Running the ${subscriberCount}-subscriber group (${completedSamples}/${totalSamples} samples started)…`;
          }
          samples.push(await runSample(arm, config, subscriberCount, block, index + 1, order));
        }
      }
    }
    const result = summarize(config, samples);
    window.__APOLLO_REACT_RENDER_RESULTS__ = result;
    renderResult(result);
    if (status)
      status.textContent = result.proofPassed ? "Complete: proof passed." : "Complete: proof failed.";
  } catch (error) {
    resetLiveResults("latest run did not complete", "The latest run did not complete. The strips below show the expected eight-subscriber pattern.");
    if (status)
      status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    runButton.disabled = false;
    if (reactVersionSelect)
      reactVersionSelect.disabled = false;
  }
});

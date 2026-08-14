interface PatchableObserver {
  next?: (value: unknown) => void;
}

interface PatchableObservableQuery {
  observers: Set<PatchableObserver>;
  queryManager: object;
}

interface PatchableApolloClient {
  getObservableQueries: (include?: 'active' | 'all') => Map<unknown, PatchableObservableQuery>;
  version: string;
  watchQuery?: (options: Record<string, unknown>) => PatchableObservableQuery;
}

interface PendingObserverDelivery {
  observer: PatchableObserver;
  originalNext: (value: unknown) => void;
  thisArgument: unknown;
  value: unknown;
}

interface SharedObserverDeliveryScheduler {
  pending: PendingObserverDelivery[];
  timer?: ReturnType<typeof globalThis.setTimeout>;
}

export interface SharedObserverDeliveryPatchDiagnostics {
  batches: number;
  delivered: number;
  maxDeliveriesPerBatch: number;
  queued: number;
}

export interface SharedObserverDeliveryPatchHandle {
  diagnostics: SharedObserverDeliveryPatchDiagnostics;
  restore: () => void;
}

export const installApollo314SharedObserverDeliveryTaskPatch = (
  client: PatchableApolloClient,
): SharedObserverDeliveryPatchHandle => {
  if (client.version !== '3.14.1') {
    throw new Error(`The shared-delivery diagnostic patch only supports Apollo 3.14.1, received ${client.version}`);
  }

  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const diagnostics: SharedObserverDeliveryPatchDiagnostics = {
    batches: 0,
    delivered: 0,
    maxDeliveriesPerBatch: 0,
    queued: 0,
  };
  const schedulersByQueryManager = new WeakMap<object, SharedObserverDeliveryScheduler>();
  const activeSchedulers = new Set<SharedObserverDeliveryScheduler>();
  const originalObserverNextFunctions = new Map<PatchableObserver, (value: unknown) => void>();
  const originalObserverSetAddFunctions = new Map<
    Set<PatchableObserver>,
    Set<PatchableObserver>['add']
  >();
  const instrumentedObservableQueries = new WeakSet<object>();

  const getScheduler = (queryManager: object): SharedObserverDeliveryScheduler => {
    const existing = schedulersByQueryManager.get(queryManager);
    if (existing) return existing;
    const created: SharedObserverDeliveryScheduler = { pending: [] };
    schedulersByQueryManager.set(queryManager, created);
    activeSchedulers.add(created);
    return created;
  };

  const flush = (scheduler: SharedObserverDeliveryScheduler): void => {
    scheduler.timer = undefined;
    const pending = scheduler.pending.splice(0);
    if (pending.length === 0) return;
    diagnostics.batches += 1;
    diagnostics.maxDeliveriesPerBatch = Math.max(diagnostics.maxDeliveriesPerBatch, pending.length);
    let firstError: unknown;
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

  const instrumentObserver = (observable: PatchableObservableQuery, observer: PatchableObserver): void => {
    if (originalObserverNextFunctions.has(observer) || typeof observer.next !== 'function') return;
    const originalNext = observer.next;
    originalObserverNextFunctions.set(observer, originalNext);
    observer.next = function queueObserverDelivery(value: unknown): void {
      diagnostics.queued += 1;
      const scheduler = getScheduler(observable.queryManager);
      scheduler.pending.push({
        observer,
        originalNext,
        thisArgument: this,
        value,
      });
      if (scheduler.timer === undefined) {
        scheduler.timer = originalSetTimeout(() => flush(scheduler), 0);
      }
    };
  };

  const instrumentObservableQuery = (observable: PatchableObservableQuery): void => {
    if (instrumentedObservableQueries.has(observable)) return;
    instrumentedObservableQueries.add(observable);
    const observerSet = observable.observers;
    if (!originalObserverSetAddFunctions.has(observerSet)) {
      const originalAdd = observerSet.add;
      originalObserverSetAddFunctions.set(observerSet, originalAdd);
      observerSet.add = function addInstrumentedObserver(observer: PatchableObserver): Set<PatchableObserver> {
        instrumentObserver(observable, observer);
        return originalAdd.call(this, observer);
      };
    }
    for (const observer of observerSet) instrumentObserver(observable, observer);
  };

  for (const observable of client.getObservableQueries('all').values()) {
    instrumentObservableQuery(observable);
  }

  const originalWatchQuery = client.watchQuery;
  if (typeof originalWatchQuery === 'function') {
    client.watchQuery = function watchInstrumentedQuery(options): PatchableObservableQuery {
      const observable = originalWatchQuery.call(this, options);
      instrumentObservableQuery(observable);
      return observable;
    };
  }

  return {
    diagnostics,
    restore: () => {
      for (const scheduler of activeSchedulers) {
        if (scheduler.timer !== undefined) globalThis.clearTimeout(scheduler.timer);
        if (scheduler.pending.length > 0) flush(scheduler);
      }
      for (const [observer, originalNext] of originalObserverNextFunctions) observer.next = originalNext;
      for (const [observerSet, originalAdd] of originalObserverSetAddFunctions) observerSet.add = originalAdd;
      if (typeof originalWatchQuery === 'function') client.watchQuery = originalWatchQuery;
      activeSchedulers.clear();
    },
  };
};

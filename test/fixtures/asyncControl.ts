import type { FakeClock } from './fakeClock.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export interface TrackedPromise<T> {
  readonly promise: Promise<T>;
  /** Разрешается после итога промиса и никогда не отклоняется */
  readonly done: Promise<void>;
  readonly settled: boolean;
  readonly error: unknown;
  readonly value: T | undefined;
}

export function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
  const state: { settled: boolean; error: unknown; value: T | undefined } = {
    settled: false,
    error: undefined,
    value: undefined,
  };
  const done = promise.then(
    (value) => {
      state.value = value;
      state.settled = true;
    },
    (error: unknown) => {
      state.error = error;
      state.settled = true;
    },
  );
  return {
    promise,
    done,
    get settled() {
      return state.settled;
    },
    get error() {
      return state.error;
    },
    get value() {
      return state.value;
    },
  };
}

/** Даёт выполниться микрозадачам и завершённым файловым операциям без реального ожидания по времени */
export function flushAsyncWork(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function waitForCondition(condition: () => boolean, maximumIterations = 10_000): Promise<void> {
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    if (condition()) {
      return;
    }
    await flushAsyncWork();
  }
  throw new Error('condition was not reached');
}

/**
 * Двигает часы шагами, каждый раз дожидаясь нужного числа ожиданий или итога операции
 * @returns время часов в момент итога
 */
export async function advanceClockUntilSettled(
  clock: FakeClock,
  tracked: TrackedPromise<unknown>,
  options: { stepMilliseconds?: number; maximumSteps?: number; pendingSleepCount?: number } = {},
): Promise<number> {
  const { stepMilliseconds = 1_000, maximumSteps = 2_000, pendingSleepCount = 1 } = options;
  for (let step = 0; step <= maximumSteps; step += 1) {
    await Promise.race([clock.waitForPendingSleeps(pendingSleepCount), tracked.done]);
    if (tracked.settled) {
      return clock.now();
    }
    if (step === maximumSteps) {
      break;
    }
    clock.advance(stepMilliseconds);
  }
  throw new Error('operation did not settle while advancing the fake clock');
}

/** Делает ровно count шагов часов; бросает, если операция завершилась раньше */
export async function advanceClockSteps(
  clock: FakeClock,
  tracked: TrackedPromise<unknown>,
  count: number,
  stepMilliseconds = 1_000,
  pendingSleepCount = 1,
): Promise<void> {
  for (let step = 0; step < count; step += 1) {
    await Promise.race([clock.waitForPendingSleeps(pendingSleepCount), tracked.done]);
    if (tracked.settled) {
      throw new Error(`operation settled after ${step} clock steps: ${String(tracked.error ?? tracked.value)}`);
    }
    clock.advance(stepMilliseconds);
  }
}

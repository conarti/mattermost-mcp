import { ABORT_EVENT } from '../../src/authentication/constants.js';
import type { Clock } from '../../src/authentication/runtime.js';

interface PendingSleep {
  dueMilliseconds: number;
  sequence: number;
  resolve: () => void;
}

interface ScheduledInterval {
  callback: () => void;
  intervalMilliseconds: number;
  dueMilliseconds: number;
  sequence: number;
}

interface PendingSleepWaiter {
  count: number;
  resolve: () => void;
}

/** Ручные часы: время двигается только через advance, поэтому ожидания в тестах считаются шагами */
export class FakeClock implements Clock {
  private currentMilliseconds: number;
  private nextSequence = 0;
  private nextIntervalHandle = 1;
  private readonly pendingSleeps: PendingSleep[] = [];
  private readonly intervals = new Map<number, ScheduledInterval>();
  private readonly sleepWaiters: PendingSleepWaiter[] = [];

  constructor(startMilliseconds: number) {
    this.currentMilliseconds = startMilliseconds;
  }

  now(): number {
    return this.currentMilliseconds;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const handleAbort = () => {
        this.removePendingSleep(pendingSleep);
        resolve();
      };
      const pendingSleep: PendingSleep = {
        dueMilliseconds: this.currentMilliseconds + milliseconds,
        sequence: this.nextSequence++,
        resolve: () => {
          signal?.removeEventListener(ABORT_EVENT, handleAbort);
          resolve();
        },
      };
      signal?.addEventListener(ABORT_EVENT, handleAbort, { once: true });
      this.pendingSleeps.push(pendingSleep);
      this.notifySleepWaiters();
    });
  }

  setInterval(callback: () => void, milliseconds: number): unknown {
    if (milliseconds <= 0) {
      throw new Error('FakeClock interval must be positive');
    }
    const handle = this.nextIntervalHandle++;
    this.intervals.set(handle, {
      callback,
      intervalMilliseconds: milliseconds,
      dueMilliseconds: this.currentMilliseconds + milliseconds,
      sequence: this.nextSequence++,
    });
    return handle;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') {
      this.intervals.delete(handle);
    }
  }

  /** Срабатывает ожидания и интервалы по порядку срока; ожидания, созданные их продолжениями, ждут следующего advance */
  advance(milliseconds: number): void {
    const targetMilliseconds = this.currentMilliseconds + milliseconds;
    while (true) {
      const nextSleep = this.findEarliestSleep(targetMilliseconds);
      const nextInterval = this.findEarliestInterval(targetMilliseconds);
      if (nextSleep === undefined && nextInterval === undefined) {
        break;
      }
      if (nextInterval === undefined || (nextSleep !== undefined && FakeClock.isEarlier(nextSleep, nextInterval))) {
        const sleep = nextSleep as PendingSleep;
        this.currentMilliseconds = Math.max(this.currentMilliseconds, sleep.dueMilliseconds);
        this.removePendingSleep(sleep);
        sleep.resolve();
      } else {
        this.currentMilliseconds = Math.max(this.currentMilliseconds, nextInterval.dueMilliseconds);
        nextInterval.dueMilliseconds += nextInterval.intervalMilliseconds;
        nextInterval.sequence = this.nextSequence++;
        nextInterval.callback();
      }
    }
    this.currentMilliseconds = targetMilliseconds;
  }

  waitForPendingSleeps(count: number): Promise<void> {
    if (this.pendingSleeps.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.sleepWaiters.push({ count, resolve });
    });
  }

  pendingSleepCount(): number {
    return this.pendingSleeps.length;
  }

  private static isEarlier(
    first: { dueMilliseconds: number; sequence: number },
    second: { dueMilliseconds: number; sequence: number },
  ): boolean {
    return (
      first.dueMilliseconds < second.dueMilliseconds ||
      (first.dueMilliseconds === second.dueMilliseconds && first.sequence < second.sequence)
    );
  }

  private findEarliestSleep(targetMilliseconds: number): PendingSleep | undefined {
    let earliest: PendingSleep | undefined;
    for (const sleep of this.pendingSleeps) {
      if (sleep.dueMilliseconds <= targetMilliseconds && (earliest === undefined || FakeClock.isEarlier(sleep, earliest))) {
        earliest = sleep;
      }
    }
    return earliest;
  }

  private findEarliestInterval(targetMilliseconds: number): ScheduledInterval | undefined {
    let earliest: ScheduledInterval | undefined;
    for (const interval of this.intervals.values()) {
      if (
        interval.dueMilliseconds <= targetMilliseconds &&
        (earliest === undefined || FakeClock.isEarlier(interval, earliest))
      ) {
        earliest = interval;
      }
    }
    return earliest;
  }

  private removePendingSleep(sleep: PendingSleep): void {
    const index = this.pendingSleeps.indexOf(sleep);
    if (index !== -1) {
      this.pendingSleeps.splice(index, 1);
    }
  }

  private notifySleepWaiters(): void {
    for (let index = this.sleepWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.sleepWaiters[index];
      if (this.pendingSleeps.length >= waiter.count) {
        this.sleepWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

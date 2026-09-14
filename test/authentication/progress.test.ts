import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOGIN_PROGRESS_MESSAGE } from '../../src/authentication/constants.js';
import { systemClock } from '../../src/authentication/runtime.js';
import {
  BACKGROUND_CALL_CONTEXT,
  RequestCallContext,
  awaitWithProgress,
  createToolCallContext,
} from '../../src/authentication/session.js';
import { createDeferred, flushAsyncWork } from '../fixtures/asyncControl.js';
import { LogCapture, createLogCapture } from '../fixtures/captureLogs.js';
import { FakeClock } from '../fixtures/fakeClock.js';

const PROGRESS_INTERVAL_MILLISECONDS = 10_000;
const PROGRESS_TOKEN = 'progress-token-1';
const OPERATION_RESULT = 'operation-result';

interface SentNotification {
  progressToken: string | number;
  progress: number;
  message: string;
}

interface RecordingCallContext {
  context: RequestCallContext;
  notifications: SentNotification[];
  logs: LogCapture;
  controller: AbortController;
}

function createRecordingCallContext(options: { progressToken?: string; sendFails?: boolean } = {}): RecordingCallContext {
  const notifications: SentNotification[] = [];
  const logs = createLogCapture();
  const controller = new AbortController();
  const context = createToolCallContext({
    progressToken: options.progressToken,
    sendProgressNotification: async (parameters) => {
      notifications.push(parameters);
      if (options.sendFails) {
        throw new Error('Not connected');
      }
    },
    cancellationSignal: controller.signal,
    logger: logs.logger,
  });
  return { context, notifications, logs, controller };
}

test('P1: without a progress token no notifications are sent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications } = createRecordingCallContext();
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  for (let tick = 0; tick < 3; tick += 1) {
    t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  }
  operation.resolve(OPERATION_RESULT);

  assert.equal(await result, OPERATION_RESULT);
  assert.equal(context.reportProgress, undefined);
  assert.equal(notifications.length, 0);
});

test('P2: three ticks send progress 10, 20 and 30 and stop after the operation settles', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications } = createRecordingCallContext({ progressToken: PROGRESS_TOKEN });
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  for (let tick = 0; tick < 3; tick += 1) {
    t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  }

  assert.deepEqual(
    notifications.map((notification) => notification.progress),
    [10, 20, 30],
  );
  for (const notification of notifications) {
    assert.equal(notification.progressToken, PROGRESS_TOKEN);
    assert.match(notification.message, /browser window/);
  }

  operation.resolve(OPERATION_RESULT);
  assert.equal(await result, OPERATION_RESULT);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  assert.equal(notifications.length, 3);
});

test('P3: a failing notification does not reject the wait and is logged once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications, logs } = createRecordingCallContext({
    progressToken: PROGRESS_TOKEN,
    sendFails: true,
  });
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  for (let tick = 0; tick < 3; tick += 1) {
    t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
    await flushAsyncWork();
  }
  operation.resolve(OPERATION_RESULT);

  assert.equal(await result, OPERATION_RESULT);
  await flushAsyncWork();
  assert.equal(notifications.length, 3);
  assert.equal(logs.count('progress notification failed'), 1);
});

test('P3: a notification sender that throws synchronously is handled the same way', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = createLogCapture();
  const context = createToolCallContext({
    progressToken: PROGRESS_TOKEN,
    sendProgressNotification: () => {
      throw new Error('Not connected');
    },
    cancellationSignal: new AbortController().signal,
    logger: logs.logger,
  });
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  operation.resolve(OPERATION_RESULT);

  assert.equal(await result, OPERATION_RESULT);
  assert.equal(logs.count('progress notification failed'), 1);
});

test('P4: cancellation stops the ticker and is logged once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications, logs, controller } = createRecordingCallContext({ progressToken: PROGRESS_TOKEN });
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  assert.equal(notifications.length, 1);

  controller.abort();
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  assert.equal(notifications.length, 1);
  assert.equal(logs.count('caller cancelled, sign-in continues in background'), 1);

  operation.resolve(OPERATION_RESULT);
  assert.equal(await result, OPERATION_RESULT);
  assert.equal(logs.count('caller cancelled, sign-in continues in background'), 1);
});

test('P5: the background call context and its authentication state are frozen', () => {
  assert.equal(Object.isFrozen(BACKGROUND_CALL_CONTEXT), true);
  assert.equal(Object.isFrozen(BACKGROUND_CALL_CONTEXT.authenticationState), true);
  assert.equal(BACKGROUND_CALL_CONTEXT.interactive, false);
  assert.equal(BACKGROUND_CALL_CONTEXT.reportProgress, undefined);
  assert.equal(BACKGROUND_CALL_CONTEXT.authenticationState.browserLoginStarted, false);

  const first = createRecordingCallContext({ progressToken: PROGRESS_TOKEN }).context;
  const second = createRecordingCallContext({ progressToken: PROGRESS_TOKEN }).context;
  assert.equal(first.interactive, true);
  assert.notEqual(first.authenticationState, second.authenticationState);
});

test('P6: the notification text follows the current status at every tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications } = createRecordingCallContext({ progressToken: PROGRESS_TOKEN });
  const operation = createDeferred<string>();
  let status = 'A';

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS, systemClock, () => status);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  status = 'B';
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  operation.resolve(OPERATION_RESULT);
  await result;

  assert.deepEqual(
    notifications.map((notification) => notification.message),
    ['A (10 s)', 'B (20 s)'],
  );
});

test('P6: the default status is the browser window message', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { context, notifications } = createRecordingCallContext({ progressToken: PROGRESS_TOKEN });
  const operation = createDeferred<string>();

  const result = awaitWithProgress(operation.promise, context, PROGRESS_INTERVAL_MILLISECONDS);
  t.mock.timers.tick(PROGRESS_INTERVAL_MILLISECONDS);
  operation.resolve(OPERATION_RESULT);
  await result;

  assert.deepEqual(
    notifications.map((notification) => notification.message),
    [`${LOGIN_PROGRESS_MESSAGE} (10 s)`],
  );
});

test('P7: system clock sleep resolves on abort and removes its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mockedSetTimeout = globalThis.setTimeout;
  let firedTimerCount = 0;
  /* Обёртка над подменённым setTimeout считает сработавшие обратные вызовы */
  globalThis.setTimeout = ((callback: () => void, milliseconds?: number) =>
    mockedSetTimeout(() => {
      firedTimerCount += 1;
      callback();
    }, milliseconds)) as typeof setTimeout;
  try {
    const controller = new AbortController();
    let sleepResolved = false;
    const sleep = systemClock.sleep(30_000, controller.signal).then(() => {
      sleepResolved = true;
    });
    await flushAsyncWork();
    assert.equal(sleepResolved, false);

    controller.abort();
    await sleep;
    assert.equal(sleepResolved, true);
    t.mock.timers.tick(30_000);
    assert.equal(firedTimerCount, 0);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let immediateResolved = false;
    const immediateSleep = systemClock.sleep(30_000, alreadyAborted.signal).then(() => {
      immediateResolved = true;
    });
    await immediateSleep;
    assert.equal(immediateResolved, true);
    t.mock.timers.tick(30_000);
    assert.equal(firedTimerCount, 0);

    let plainResolved = false;
    const plainSleep = systemClock.sleep(30_000).then(() => {
      plainResolved = true;
    });
    t.mock.timers.tick(30_000);
    await plainSleep;
    assert.equal(plainResolved, true);
    assert.equal(firedTimerCount, 1);
  } finally {
    globalThis.setTimeout = mockedSetTimeout;
  }
});

test('P7: fake clock sleep cancellation removes the pending sleep', async () => {
  const clock = new FakeClock(1_000_000_000_000);
  const controller = new AbortController();
  const cancelledSleep = clock.sleep(30_000, controller.signal);
  assert.equal(clock.pendingSleepCount(), 1);

  controller.abort();
  await cancelledSleep;
  assert.equal(clock.pendingSleepCount(), 0);

  let waiterResolved = false;
  const waiter = clock.waitForPendingSleeps(1).then(() => {
    waiterResolved = true;
  });
  await flushAsyncWork();
  assert.equal(waiterResolved, false);

  const activeSleep = clock.sleep(1_000);
  await waiter;
  assert.equal(waiterResolved, true);
  clock.advance(1_000);
  await activeSleep;
  assert.equal(clock.pendingSleepCount(), 0);
});

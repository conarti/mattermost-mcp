import {
  ABORT_EVENT,
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_LOG_PREFIX,
  SHUTDOWN_SIGNALS,
} from './constants.js';

export type AuthenticationErrorCode = typeof AUTHENTICATION_ERROR_CODES[keyof typeof AUTHENTICATION_ERROR_CODES];

export class MattermostAuthenticationError extends Error {
  readonly code: AuthenticationErrorCode;

  constructor(code: AuthenticationErrorCode, description: string) {
    super(`[${code}] ${description}`);
    this.name = 'MattermostAuthenticationError';
    this.code = code;
  }
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

export type AuthenticationLogger = (message: string) => void;

export function createStderrAuthenticationLogger(): AuthenticationLogger {
  return (message) => {
    console.error(`${AUTHENTICATION_LOG_PREFIX} ${message}`);
  };
}

export interface Clock {
  now(): number;
  /** При отмене сигнала таймер снимается, а промис разрешается сразу */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

/* Глобальные функции берутся в момент вызова, чтобы mock.timers в тестах подменял и эти часы */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const handleAbort = () => {
        clearTimeout(timeoutHandle);
        resolve();
      };
      const timeoutHandle = setTimeout(() => {
        signal?.removeEventListener(ABORT_EVENT, handleAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener(ABORT_EVENT, handleAbort, { once: true });
    }),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function installProcessShutdownHandlers(onShutdown: () => void): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      /* Без finally исключение из onShutdown завершило бы процесс с кодом 1 */
      try {
        onShutdown();
      } finally {
        process.exit(0);
      }
    });
  }
}

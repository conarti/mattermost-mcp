import {
  ABORT_EVENT,
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_LOG_PREFIX,
  FILE_SYSTEM_ERROR_CODES,
  MILLISECONDS_PER_SECOND,
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

/** Первая строка текста ошибки: стек и многострочные рамки Playwright в сообщения не попадают */
export function getErrorFirstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text.trim();
}

export function toSeconds(milliseconds: number): number {
  return Math.round(milliseconds / MILLISECONDS_PER_SECOND);
}

export function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== FILE_SYSTEM_ERROR_CODES.NO_SUCH_PROCESS;
  }
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

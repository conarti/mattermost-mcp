import { ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  ABORT_EVENT,
  ASCII_BOX_CHARACTERS_PATTERN,
  ASCII_BOX_LINE_PATTERN,
  AUTHENTICATION_ERROR_CODES,
  AuthenticationTimings,
  CHROMIUM_INSTALL_ARGUMENTS,
  CLOSE_EVENT,
  DATA_EVENT,
  END_EVENT,
  ERROR_EVENT,
  INSTALLATION_ABORT_REASONS,
  INSTALLATION_FAILURE_MARKER,
  INSTALLATION_FAILURE_REASON_MAX_LENGTH,
  INSTALLATION_OUTPUT_LINE_LIMIT,
  INSTALLATION_PROGRESS_PATTERN,
  INSTALLATION_TEMPORARY_DIRECTORY_PREFIX,
  INSTALLER_KILL_SIGNAL,
  INSTALLER_TERMINATION_SIGNAL,
  MILLISECONDS_PER_SECOND,
  PINNED_PLAYWRIGHT_VERSION,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PLAYWRIGHT_CLI_FILE_NAME,
  PLAYWRIGHT_CORE_PACKAGE_JSON_SPECIFIER,
  PLAYWRIGHT_PACKAGE_JSON_SPECIFIER,
  PRIVATE_DIRECTORY_MODE,
  PROCESS_EXIT_EVENT,
  REDACTED_URL_CREDENTIALS,
  SERVER_PACKAGE_NAME,
  STACK_TRACE_LINE_PATTERN,
  TEMPORARY_DIRECTORY_VARIABLE,
  TEXT_FILE_ENCODING,
  UNKNOWN_ERROR_CODE,
  URL_CREDENTIALS_PATTERN,
} from './constants.js';
import { buildChromiumInstallCommand } from './browserLogin.js';
import {
  AuthenticationLogger,
  Clock,
  MattermostAuthenticationError,
  getErrorCode,
  getErrorFirstLine,
  systemClock,
} from './runtime.js';

export interface BrowserInstallationProgress {
  percent: number;
  totalSizeDescription: string;
}

export function parseInstallationProgressLine(line: string): BrowserInstallationProgress | undefined {
  const match = INSTALLATION_PROGRESS_PATTERN.exec(line);
  if (match === null) {
    return undefined;
  }
  return { percent: Number(match[1]), totalSizeDescription: match[2] };
}

export type ResolveModulePath = (specifier: string, fromPath: string) => string;

const resolveModulePathWithRequire: ResolveModulePath = (specifier, fromPath) =>
  createRequire(fromPath).resolve(specifier);

/** Путь к cli.js только вычисляется: модуль playwright-core в процессе сервера не импортируется */
export function resolvePlaywrightCliPath(resolveModulePath: ResolveModulePath = resolveModulePathWithRequire): string {
  const playwrightPackageJsonPath = resolveModulePath(PLAYWRIGHT_PACKAGE_JSON_SPECIFIER, import.meta.url);
  /* Разрешение от пакета playwright находит playwright-core и при вложенной установке node_modules */
  const corePackageJsonPath = resolveModulePath(PLAYWRIGHT_CORE_PACKAGE_JSON_SPECIFIER, playwrightPackageJsonPath);
  return join(dirname(corePackageJsonPath), PLAYWRIGHT_CLI_FILE_NAME);
}

export function buildInstallationEnvironment(
  browsersDirectory: string,
  temporaryDirectory: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  /* os.tmpdir() в POSIX читает TMPDIR первым, поэтому частичный архив остаётся внутри папки состояния */
  return {
    ...environment,
    [PLAYWRIGHT_BROWSERS_PATH_VARIABLE]: browsersDirectory,
    [TEMPORARY_DIRECTORY_VARIABLE]: temporaryDirectory,
  };
}

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS_PATTERN, REDACTED_URL_CREDENTIALS);
}

export interface InstallationOutput {
  stdoutLines: readonly string[];
  stderrLines: readonly string[];
  exitDescription: string;
}

function findLastLineIndex(lines: readonly string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) {
      return index;
    }
  }
  return -1;
}

function cleanOutputLines(lines: readonly string[]): string {
  return lines
    .filter((line) => !STACK_TRACE_LINE_PATTERN.test(line))
    .map((line) => line.replace(ASCII_BOX_CHARACTERS_PATTERN, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractInstallationFailureReason(output: InstallationOutput): string {
  const failureMarkerIndex = findLastLineIndex(output.stdoutLines, (line) => line.includes(INSTALLATION_FAILURE_MARKER));
  const summary = failureMarkerIndex === -1 ? '' : cleanOutputLines(output.stdoutLines.slice(failureMarkerIndex + 1));

  /* Подробную ошибку сети или распаковки внук установщика пишет в stderr; рамка WARNING про npx пропускается */
  const detailIndex = findLastLineIndex(
    output.stderrLines,
    (line) => line.trim().length > 0 && !STACK_TRACE_LINE_PATTERN.test(line) && !ASCII_BOX_LINE_PATTERN.test(line),
  );
  const detail = detailIndex === -1 ? '' : cleanOutputLines([output.stderrLines[detailIndex]]);

  let reason: string;
  if (summary !== '' && detail !== '' && summary !== detail) {
    reason = `${summary}; ${detail}`;
  } else {
    reason = summary || detail || output.exitDescription;
  }
  return redactUrlCredentials(reason).slice(0, INSTALLATION_FAILURE_REASON_MAX_LENGTH);
}

export interface InstallationChildProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  /** on, а не once: error может прийти повторно, например после неудачного kill */
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

export interface InstallationSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export type SpawnInstallationProcess = (
  command: string,
  commandArguments: readonly string[],
  options: InstallationSpawnOptions,
) => InstallationChildProcess;

export interface BrowserInstallationRequest {
  browsersDirectory: string;
  /** StatePaths.installationTemporaryDirectory */
  temporaryRootDirectory: string;
  /** reason сигнала: INSTALLATION_ABORT_REASONS.CANCELLED или LOCK_LOST */
  cancellationSignal: AbortSignal;
  onProgress(progress: BrowserInstallationProgress): void;
}

export type InstallBrowser = (request: BrowserInstallationRequest) => Promise<void>;

export interface BrowserInstallerDependencies {
  timings: Pick<AuthenticationTimings, 'browserInstallationTimeoutMilliseconds' | 'installationTerminationGraceMilliseconds'>;
  logger: AuthenticationLogger;
  clock?: Clock;
  /** По умолчанию адаптер над child_process.spawn */
  spawnProcess?: SpawnInstallationProcess;
  resolveCliPath?: () => string;
  environment?: NodeJS.ProcessEnv;
  nodeExecutablePath?: string;
  processEvents?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
}

type InstallationChildProcessEvent = typeof PROCESS_EXIT_EVENT | typeof CLOSE_EVENT;
type InstallationChildProcessEndListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** Явный адаптер: у ChildProcess поле pid необязательное, а интерфейс установщика требует его всегда */
class SpawnedInstallationProcess implements InstallationChildProcess {
  constructor(private readonly child: ChildProcessByStdio<null, Readable, Readable>) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.child.stdout;
  }

  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  once(event: InstallationChildProcessEvent, listener: InstallationChildProcessEndListener): unknown {
    return this.child.once(event, listener);
  }

  on(event: typeof ERROR_EVENT, listener: (error: Error) => void): unknown {
    return this.child.on(event, listener);
  }

  removeListener(event: typeof ERROR_EVENT, listener: (error: Error) => void): unknown {
    return this.child.removeListener(event, listener);
  }
}

const spawnWithChildProcess: SpawnInstallationProcess = (command, commandArguments, options) =>
  new SpawnedInstallationProcess(spawn(command, commandArguments, { env: options.env, stdio: options.stdio }));

type InstallerOutcome =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'start-failed'; errorCode: string }
  | { kind: 'termination-expired' };

class OutputLineBuffer {
  readonly lines: string[] = [];
  private pendingText = '';

  constructor(private readonly onLine: (line: string) => void) {}

  append(chunk: string | Buffer): void {
    this.pendingText += typeof chunk === 'string' ? chunk : chunk.toString(TEXT_FILE_ENCODING);
    const parts = this.pendingText.split('\n');
    this.pendingText = parts.pop() ?? '';
    for (const part of parts) {
      this.addLine(part);
    }
  }

  flush(): void {
    if (this.pendingText !== '') {
      const lastLine = this.pendingText;
      this.pendingText = '';
      this.addLine(lastLine);
    }
  }

  private addLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.lines.push(line);
    if (this.lines.length > INSTALLATION_OUTPUT_LINE_LIMIT) {
      this.lines.shift();
    }
    this.onLine(line);
  }
}

function readLines(stream: NodeJS.ReadableStream, buffer: OutputLineBuffer): void {
  stream.setEncoding(TEXT_FILE_ENCODING);
  stream.on(DATA_EVENT, (chunk: string | Buffer) => buffer.append(chunk));
  stream.on(END_EVENT, () => buffer.flush());
}

function describeAbortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : INSTALLATION_ABORT_REASONS.CANCELLED;
}

function toSeconds(milliseconds: number): number {
  return Math.round(milliseconds / MILLISECONDS_PER_SECOND);
}

export function createBrowserInstaller(dependencies: BrowserInstallerDependencies): InstallBrowser {
  const {
    timings,
    logger,
    clock = systemClock,
    spawnProcess = spawnWithChildProcess,
    resolveCliPath = () => resolvePlaywrightCliPath(),
    processEvents = process,
  } = dependencies;

  const createInstallationError = (description: string) =>
    new MattermostAuthenticationError(AUTHENTICATION_ERROR_CODES.BROWSER_INSTALLATION_FAILED, description);

  return async (request) => {
    const { browsersDirectory, temporaryRootDirectory, cancellationSignal, onProgress } = request;
    const manualCommand = buildChromiumInstallCommand(browsersDirectory);

    if (cancellationSignal.aborted) {
      throw createInstallationError(`Chromium installation ${describeAbortReason(cancellationSignal)} before start`);
    }

    let cliPath: string;
    try {
      cliPath = resolveCliPath();
    } catch (error) {
      throw createInstallationError(
        `Playwright ${PINNED_PLAYWRIGHT_VERSION} installer was not found (${getErrorFirstLine(error)}). Reinstall ${SERVER_PACKAGE_NAME} and retry.`,
      );
    }

    let temporaryDirectory: string;
    try {
      await mkdir(temporaryRootDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      /* Одновременно установщик запускает только держатель login.lock, поэтому здесь только остатки после SIGKILL */
      const leftoverNames = (await readdir(temporaryRootDirectory)).filter((name) =>
        name.startsWith(INSTALLATION_TEMPORARY_DIRECTORY_PREFIX),
      );
      await Promise.all(
        leftoverNames.map((name) => rm(join(temporaryRootDirectory, name), { recursive: true, force: true })),
      );
      temporaryDirectory = join(temporaryRootDirectory, `${INSTALLATION_TEMPORARY_DIRECTORY_PREFIX}${randomUUID()}`);
      await mkdir(temporaryDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      throw createInstallationError(
        `could not prepare installer temporary directory ${temporaryRootDirectory} (${getErrorCode(error) ?? UNKNOWN_ERROR_CODE})`,
      );
    }

    let deadlineHandle: unknown;
    let terminationReason: string | undefined;
    let exitReceived = false;
    let firstErrorHandled = false;
    const exitController = new AbortController();
    const closeController = new AbortController();
    const removeListeners: Array<() => void> = [];

    try {
      if (cancellationSignal.aborted) {
        throw createInstallationError(`Chromium installation ${describeAbortReason(cancellationSignal)} before start`);
      }

      logger(`Chromium installation started (Playwright ${PINNED_PLAYWRIGHT_VERSION}, ${browsersDirectory})`);
      const startedAtMilliseconds = clock.now();
      let lastProgress: BrowserInstallationProgress | undefined;
      const handleStdoutLine = (line: string): void => {
        const progress = parseInstallationProgressLine(line);
        if (
          progress === undefined ||
          (lastProgress?.percent === progress.percent &&
            lastProgress.totalSizeDescription === progress.totalSizeDescription)
        ) {
          return;
        }
        lastProgress = progress;
        onProgress(progress);
        logger(`Chromium download ${progress.percent}% of ${progress.totalSizeDescription}`);
      };
      const stdoutBuffer = new OutputLineBuffer(handleStdoutLine);
      const stderrBuffer = new OutputLineBuffer(() => undefined);

      const outcome = await new Promise<InstallerOutcome>((resolve) => {
        let finished = false;
        const finish = (result: InstallerOutcome): void => {
          if (!finished) {
            finished = true;
            resolve(result);
          }
        };

        let child: InstallationChildProcess;
        try {
          child = spawnProcess(
            dependencies.nodeExecutablePath ?? process.execPath,
            [cliPath, ...CHROMIUM_INSTALL_ARGUMENTS],
            {
              env: buildInstallationEnvironment(
                browsersDirectory,
                temporaryDirectory,
                dependencies.environment ?? process.env,
              ),
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
        } catch (error) {
          finish({ kind: 'start-failed', errorCode: getErrorCode(error) ?? getErrorFirstLine(error) });
          return;
        }

        const killChild = (signal: NodeJS.Signals): void => {
          try {
            child.kill(signal);
          } catch {
            /* процесс уже завершён */
          }
        };

        /* Синхронный и никогда не бросает: исключение отменило бы следующие обработчики exit, среди них Playwright */
        const terminateInstallerOnExit = (): void => killChild(INSTALLER_KILL_SIGNAL);
        processEvents.on(PROCESS_EXIT_EVENT, terminateInstallerOnExit);
        removeListeners.push(() => processEvents.removeListener(PROCESS_EXIT_EVENT, terminateInstallerOnExit));

        readLines(child.stdout, stdoutBuffer);
        readLines(child.stderr, stderrBuffer);

        const terminate = (reason: string): void => {
          if (terminationReason !== undefined || exitReceived) {
            return;
          }
          terminationReason = reason;
          void (async () => {
            killChild(INSTALLER_TERMINATION_SIGNAL);
            await clock.sleep(timings.installationTerminationGraceMilliseconds, exitController.signal);
            if (exitReceived) {
              return;
            }
            killChild(INSTALLER_KILL_SIGNAL);
            await clock.sleep(timings.installationTerminationGraceMilliseconds, exitController.signal);
            if (!exitReceived) {
              finish({ kind: 'termination-expired' });
            }
          })();
        };

        /* Интервал, а не sleep без сигнала: незавершённый таймер держал бы процесс после установки */
        deadlineHandle = clock.setInterval(
          () => terminate(`timed out after ${toSeconds(timings.browserInstallationTimeoutMilliseconds)} s`),
          timings.browserInstallationTimeoutMilliseconds,
        );

        const handleAbort = (): void => terminate(describeAbortReason(cancellationSignal));
        cancellationSignal.addEventListener(ABORT_EVENT, handleAbort, { once: true });
        removeListeners.push(() => cancellationSignal.removeEventListener(ABORT_EVENT, handleAbort));

        const handleError = (error: Error): void => {
          const errorCode = getErrorCode(error) ?? UNKNOWN_ERROR_CODE;
          if (!firstErrorHandled && !exitReceived) {
            firstErrorHandled = true;
            finish({ kind: 'start-failed', errorCode });
            return;
          }
          logger(`installer process error (${errorCode})`);
        };
        child.on(ERROR_EVENT, handleError);
        removeListeners.push(() => child.removeListener(ERROR_EVENT, handleError));

        let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        child.once(PROCESS_EXIT_EVENT, (code, signal) => {
          exitReceived = true;
          exitResult = { code, signal };
          exitController.abort();
          /* Поток может держать внук установщика, поэтому close ждётся не дольше паузы завершения */
          void clock
            .sleep(timings.installationTerminationGraceMilliseconds, closeController.signal)
            .then(() => finish({ kind: 'exited', code, signal }));
        });
        child.once(CLOSE_EVENT, (code, signal) => {
          closeController.abort();
          finish({ kind: 'exited', code: exitResult?.code ?? code, signal: exitResult?.signal ?? signal });
        });
      });

      if (outcome.kind === 'start-failed') {
        throw createInstallationError(`could not start installer: ${outcome.errorCode}`);
      }
      if (terminationReason !== undefined || outcome.kind === 'termination-expired') {
        logger(`Chromium installation ${terminationReason}, installer terminated`);
        throw createInstallationError(
          `Chromium installation ${terminationReason}, installer terminated. Run manually: ${manualCommand}`,
        );
      }
      if (outcome.code === 0 && outcome.signal === null) {
        logger(`Chromium installation finished in ${toSeconds(clock.now() - startedAtMilliseconds)} s`);
        return;
      }

      const reason = extractInstallationFailureReason({
        stdoutLines: stdoutBuffer.lines,
        stderrLines: stderrBuffer.lines,
        exitDescription: outcome.code !== null ? `exit code ${outcome.code}` : `signal ${outcome.signal}`,
      });
      logger(`Chromium installation failed: ${reason}`);
      throw createInstallationError(`Chromium download failed: ${reason}. Run manually: ${manualCommand}`);
    } finally {
      for (const removeListener of removeListeners) {
        removeListener();
      }
      if (deadlineHandle !== undefined) {
        clock.clearInterval(deadlineHandle);
      }
      exitController.abort();
      closeController.abort();
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        logger(`installer temporary directory cleanup failed (${getErrorCode(error) ?? UNKNOWN_ERROR_CODE})`);
      }
    }
  };
}

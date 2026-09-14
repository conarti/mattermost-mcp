import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  AUTHENTICATION_ERROR_CODES,
  BROWSERS_DIRECTORY_NAME,
  CONFIG_DIRECTORY_NAME,
  EXCLUSIVE_CREATE_FLAG,
  FILE_SYSTEM_ERROR_CODES,
  INSTALLATION_TEMPORARY_DIRECTORY_NAME,
  LOGIN_LOCK_BREAK_FILE_NAME,
  LOGIN_LOCK_FILE_NAME,
  NOT_DIRECTORY_ERROR_CODE,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  PROFILE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
  SYMBOLIC_LINK_LOOP_ERROR_CODE,
  TEMPORARY_FILE_EXTENSION,
  TEXT_FILE_ENCODING,
  TOKEN_FILE_NAME,
  TRAILING_SLASHES_PATTERN,
} from './constants.js';
import { AuthenticationLogger, MattermostAuthenticationError, getErrorCode } from './runtime.js';

const PERMISSION_BITS_MASK = 0o777;
const PRIVATE_DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/* O_NONBLOCK не даёт зависнуть на FIFO, подложенном вместо файла токена */
const TOKEN_FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SYMBOLIC_LINK_PROBLEM = 'is a symbolic link';
const NOT_DIRECTORY_PROBLEM = 'is not a directory';
const FOREIGN_OWNER_PROBLEM = 'is owned by another user';
const PROCESS_ID_PATTERN = /^[1-9]\d*$/;
const TEMPORARY_FILE_NAME_SEPARATOR = '.';

export interface StatePaths {
  stateDirectory: string;
  profileDirectory: string;
  browsersDirectory: string;
  tokenFilePath: string;
  loginLockPath: string;
  loginLockBreakPath: string;
  /** Временные файлы установщика Chromium */
  installationTemporaryDirectory: string;
}

export function resolveStatePaths(homeDirectory: string = homedir()): StatePaths {
  const stateDirectory = join(homeDirectory, CONFIG_DIRECTORY_NAME, STATE_DIRECTORY_NAME);
  return {
    stateDirectory,
    profileDirectory: join(stateDirectory, PROFILE_DIRECTORY_NAME),
    browsersDirectory: join(stateDirectory, BROWSERS_DIRECTORY_NAME),
    tokenFilePath: join(stateDirectory, TOKEN_FILE_NAME),
    loginLockPath: join(stateDirectory, LOGIN_LOCK_FILE_NAME),
    loginLockBreakPath: join(stateDirectory, LOGIN_LOCK_BREAK_FILE_NAME),
    installationTemporaryDirectory: join(stateDirectory, INSTALLATION_TEMPORARY_DIRECTORY_NAME),
  };
}

function createUnsafeStateDirectoryError(stateDirectory: string, problem: string): MattermostAuthenticationError {
  return new MattermostAuthenticationError(
    AUTHENTICATION_ERROR_CODES.STATE_DIRECTORY_UNSAFE,
    `State directory ${stateDirectory} ${problem}. Remove it or fix it manually, then retry.`,
  );
}

/** Закрывает дескриптор после операции; ошибка закрытия не заглушает уже летящую ошибку операции */
async function useFileHandle<Result>(handle: FileHandle, operation: () => Promise<Result>): Promise<Result> {
  let result: Result;
  try {
    result = await operation();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}

function isOwnedByAnotherUser(stats: Stats): boolean {
  const currentUserId = process.getuid?.();
  return currentUserId !== undefined && stats.uid !== currentUserId;
}

/* Проверки и chmod идут через дескриптор, поэтому подмена пути на symlink после открытия не меняет права цели */
async function securePrivateDirectory(directory: string): Promise<void> {
  const handle = await open(directory, PRIVATE_DIRECTORY_OPEN_FLAGS).catch(async (error: unknown) => {
    const errorCode = getErrorCode(error);
    if (errorCode !== SYMBOLIC_LINK_LOOP_ERROR_CODE && errorCode !== NOT_DIRECTORY_ERROR_CODE) {
      throw error;
    }
    /* На symlink с O_DIRECTORY Linux может ответить ENOTDIR, поэтому вид записи уточняется отдельно */
    const isSymbolicLink = await lstat(directory).then((stats) => stats.isSymbolicLink(), () => false);
    throw createUnsafeStateDirectoryError(directory, isSymbolicLink ? SYMBOLIC_LINK_PROBLEM : NOT_DIRECTORY_PROBLEM);
  });

  await useFileHandle(handle, async () => {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw createUnsafeStateDirectoryError(directory, NOT_DIRECTORY_PROBLEM);
    }
    if (isOwnedByAnotherUser(stats)) {
      throw createUnsafeStateDirectoryError(directory, FOREIGN_OWNER_PROBLEM);
    }
    /* Установщик Playwright создаёт папки без явного режима, поэтому права ужесточаются */
    if ((stats.mode & PERMISSION_BITS_MASK) !== PRIVATE_DIRECTORY_MODE) {
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
    }
  });
}

export async function ensureStateDirectory(paths: StatePaths): Promise<void> {
  const { stateDirectory } = paths;
  /* Родительская ~/.config общая для других программ, поэтому создаётся с правами по умолчанию */
  await mkdir(dirname(stateDirectory), { recursive: true });
  try {
    await mkdir(stateDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (getErrorCode(error) !== FILE_SYSTEM_ERROR_CODES.ALREADY_EXISTS) {
      throw error;
    }
  }
  await securePrivateDirectory(stateDirectory);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (getErrorCode(error) !== FILE_SYSTEM_ERROR_CODES.ALREADY_EXISTS) {
      throw error;
    }
  }
  await securePrivateDirectory(directory);
}

export interface TokenStore {
  readToken(siteUrl: string): Promise<string | undefined>;
  writeToken(siteUrl: string, token: string): Promise<void>;
}

const MALFORMED_TOKEN_FILE_MESSAGE = 'token file is malformed, ignoring';
const FOREIGN_TOKEN_FILE_MESSAGE = 'token file belongs to another server, ignoring';
const SYMBOLIC_LINK_TOKEN_FILE_MESSAGE = 'token file is a symbolic link, ignoring';
const IRREGULAR_TOKEN_FILE_MESSAGE = 'token file is not a regular file, ignoring';
const FOREIGN_OWNER_TOKEN_FILE_MESSAGE = 'token file is owned by another user, ignoring';
const WIDE_PERMISSIONS_TOKEN_FILE_MESSAGE = 'token file permissions are wider than 0600, ignoring';

function normalizeSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).href.replace(TRAILING_SLASHES_PATTERN, '');
}

function parseStoredSiteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return normalizeSiteUrl(value);
  } catch {
    return undefined;
  }
}

/*
 * Файл с широкими правами не исправляется chmod, а игнорируется: чтение идёт и при старте, где ничего не пишется,
 * а секрет из такого файла мог уже утечь. Следующий вход заменит файл новым с правами 0600
 */
function describeUnsafeTokenFile(stats: Stats): string | undefined {
  if (!stats.isFile()) {
    return IRREGULAR_TOKEN_FILE_MESSAGE;
  }
  if (isOwnedByAnotherUser(stats)) {
    return FOREIGN_OWNER_TOKEN_FILE_MESSAGE;
  }
  if ((stats.mode & PERMISSION_BITS_MASK & ~PRIVATE_FILE_MODE) !== 0) {
    return WIDE_PERMISSIONS_TOKEN_FILE_MESSAGE;
  }
  return undefined;
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== FILE_SYSTEM_ERROR_CODES.NO_SUCH_PROCESS;
  }
}

/* Временный файл с токеном переживает SIGKILL писателя; PID в имени показывает, что писателя уже нет */
async function removeAbandonedTemporaryTokenFiles(tokenFilePath: string): Promise<void> {
  const directory = dirname(tokenFilePath);
  const temporaryFilePrefix = `${basename(tokenFilePath)}${TEMPORARY_FILE_NAME_SEPARATOR}`;
  const entryNames = await readdir(directory);
  await Promise.all(
    entryNames.map(async (entryName) => {
      if (!entryName.startsWith(temporaryFilePrefix) || !entryName.endsWith(TEMPORARY_FILE_EXTENSION)) {
        return;
      }
      const processIdText = entryName.slice(temporaryFilePrefix.length).split(TEMPORARY_FILE_NAME_SEPARATOR)[0];
      if (!PROCESS_ID_PATTERN.test(processIdText) || isProcessRunning(Number(processIdText))) {
        return;
      }
      await unlink(join(directory, entryName)).catch(() => undefined);
    }),
  );
}

async function synchronizeDirectory(directory: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(directory, 'r');
    await directoryHandle.sync();
  } catch {
    /* Синхронизация папки поддерживается не везде, запись токена от неё не зависит */
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

export function createFileTokenStore(paths: StatePaths, logger: AuthenticationLogger): TokenStore {
  let lastReportedProblem: string | undefined;

  const reportProblem = (message: string | undefined): void => {
    if (message !== undefined && message !== lastReportedProblem) {
      logger(message);
    }
    lastReportedProblem = message;
  };

  const readToken = async (siteUrl: string): Promise<string | undefined> => {
    const handle = await open(paths.tokenFilePath, TOKEN_FILE_OPEN_FLAGS).catch((error: unknown) => {
      const errorCode = getErrorCode(error);
      if (errorCode === FILE_SYSTEM_ERROR_CODES.NOT_FOUND) {
        reportProblem(undefined);
        return undefined;
      }
      if (errorCode === SYMBOLIC_LINK_LOOP_ERROR_CODE) {
        reportProblem(SYMBOLIC_LINK_TOKEN_FILE_MESSAGE);
        return undefined;
      }
      throw error;
    });
    if (handle === undefined) {
      return undefined;
    }

    const rawContent = await useFileHandle(handle, async () => {
      const unsafeFileMessage = describeUnsafeTokenFile(await handle.stat());
      if (unsafeFileMessage !== undefined) {
        reportProblem(unsafeFileMessage);
        return undefined;
      }
      return handle.readFile(TEXT_FILE_ENCODING);
    });
    if (rawContent === undefined) {
      return undefined;
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch {
      reportProblem(MALFORMED_TOKEN_FILE_MESSAGE);
      return undefined;
    }

    if (typeof parsedContent !== 'object' || parsedContent === null) {
      reportProblem(MALFORMED_TOKEN_FILE_MESSAGE);
      return undefined;
    }
    const { siteUrl: storedSiteUrl, token } = parsedContent as Record<string, unknown>;
    const normalizedStoredSiteUrl = parseStoredSiteUrl(storedSiteUrl);
    if (typeof token !== 'string' || token.length === 0 || normalizedStoredSiteUrl === undefined) {
      reportProblem(MALFORMED_TOKEN_FILE_MESSAGE);
      return undefined;
    }
    if (normalizedStoredSiteUrl !== normalizeSiteUrl(siteUrl)) {
      reportProblem(FOREIGN_TOKEN_FILE_MESSAGE);
      return undefined;
    }

    reportProblem(undefined);
    return token;
  };

  const writeToken = async (siteUrl: string, token: string): Promise<void> => {
    await ensureStateDirectory(paths);
    await removeAbandonedTemporaryTokenFiles(paths.tokenFilePath);
    const temporaryPath = `${paths.tokenFilePath}.${process.pid}.${randomUUID()}${TEMPORARY_FILE_EXTENSION}`;
    try {
      const handle = await open(temporaryPath, EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE);
      await useFileHandle(handle, async () => {
        await handle.writeFile(JSON.stringify({ siteUrl, token }), TEXT_FILE_ENCODING);
        await handle.chmod(PRIVATE_FILE_MODE);
        await handle.sync();
      });
      await rename(temporaryPath, paths.tokenFilePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await synchronizeDirectory(paths.stateDirectory);
  };

  return { readToken, writeToken };
}

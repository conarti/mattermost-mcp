import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTHENTICATION_ERROR_CODES,
  BROWSERS_DIRECTORY_NAME,
  CONFIG_DIRECTORY_NAME,
  EXCLUSIVE_CREATE_FLAG,
  FILE_SYSTEM_ERROR_CODES,
  INSTALLATION_TEMPORARY_DIRECTORY_NAME,
  LOGIN_LOCK_BREAK_FILE_NAME,
  LOGIN_LOCK_FILE_NAME,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  PROFILE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
  TEMPORARY_FILE_EXTENSION,
  TEXT_FILE_ENCODING,
  TOKEN_FILE_NAME,
} from './constants.js';
import { AuthenticationLogger, MattermostAuthenticationError, getErrorCode } from './runtime.js';

const PERMISSION_BITS_MASK = 0o777;

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

  const stats = await lstat(stateDirectory);
  if (stats.isSymbolicLink()) {
    throw createUnsafeStateDirectoryError(stateDirectory, 'is a symbolic link');
  }
  if (!stats.isDirectory()) {
    throw createUnsafeStateDirectoryError(stateDirectory, 'is not a directory');
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw createUnsafeStateDirectoryError(stateDirectory, 'is owned by another user');
  }
  /* Установщик Playwright создаёт папки без явного режима, поэтому права ужесточаются */
  if ((stats.mode & PERMISSION_BITS_MASK) !== PRIVATE_DIRECTORY_MODE) {
    await chmod(stateDirectory, PRIVATE_DIRECTORY_MODE);
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export interface TokenStore {
  readToken(siteUrl: string): Promise<string | undefined>;
  writeToken(siteUrl: string, token: string): Promise<void>;
}

const MALFORMED_TOKEN_FILE_MESSAGE = 'token file is malformed, ignoring';
const FOREIGN_TOKEN_FILE_MESSAGE = 'token file belongs to another server, ignoring';

function normalizeSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).href.replace(/\/+$/, '');
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
    let rawContent: string;
    try {
      rawContent = await readFile(paths.tokenFilePath, TEXT_FILE_ENCODING);
    } catch (error) {
      if (getErrorCode(error) === FILE_SYSTEM_ERROR_CODES.NOT_FOUND) {
        reportProblem(undefined);
        return undefined;
      }
      throw error;
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
    const temporaryPath = `${paths.tokenFilePath}.${process.pid}.${randomUUID()}${TEMPORARY_FILE_EXTENSION}`;
    try {
      const handle = await open(temporaryPath, EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify({ siteUrl, token }), TEXT_FILE_ENCODING);
        await handle.chmod(PRIVATE_FILE_MODE);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, paths.tokenFilePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await synchronizeDirectory(paths.stateDirectory);
  };

  return { readToken, writeToken };
}

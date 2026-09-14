/**
 * Межпроцессная блокировка входа через файлы login.lock и login.lock.break.
 *
 * Возраст записей считается только по createdAtMilliseconds и часам процесса, без времени файловой системы.
 *
 * Остаточный риск: login.lock.break можно вытеснить как брошенную у любого держателя, который простоял
 * с ней дольше lockBreakStaleAgeMilliseconds (сон ноутбука, SIGSTOP). Второй путь к той же гонке:
 * удаление брошенной login.lock.break идёт как «перечитать, затем удалить», и между этими действиями
 * другой процесс может удалить её сам и записать свежую, которую первый затем удалит. Третий путь:
 * renew() заменяет login.lock через rename безусловно, и держатель, заснувший между проверкой nonce
 * и rename, перезапишет запись процесса, который успел снять блокировку. В этих случаях два процесса
 * могут считать себя держателями, и последней защитой от второго входа остаётся singleton-блокировка
 * профиля Chromium.
 *
 * Запись login.lock из будущего не считается брошенной: у мёртвого держателя её снимает проверка PID, а у живого
 * такое правило после скачка часов назад отобрало бы блокировку. login.lock.break из будущего дальше порога
 * считается брошенной: её держат миллисекунды, а без правила упавший держатель заблокировал бы вход, пока часы
 * не догонят её время.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants, link, open, rename, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  AuthenticationTimings,
  EXCLUSIVE_CREATE_FLAG,
  FILE_SYSTEM_ERROR_CODES,
  MILLISECONDS_PER_SECOND,
  PRIVATE_FILE_MODE,
  PROCESS_EXIT_EVENT,
  SYMBOLIC_LINK_LOOP_ERROR_CODE,
  TEMPORARY_FILE_EXTENSION,
  TEXT_FILE_ENCODING,
  UNKNOWN_ERROR_CODE,
} from './constants.js';
import { AuthenticationLogger, Clock, getErrorCode, isProcessAlive, systemClock } from './runtime.js';
import { StatePaths, ensureStateDirectory } from './stateFiles.js';

export { isProcessAlive };

export interface LoginLockRecord {
  processId: number;
  createdAtMilliseconds: number;
  nonce: string;
}

export type LoginLockRenewalResult = 'renewed' | 'lost' | 'busy';

export interface HeldLoginLock {
  readonly record: LoginLockRecord;
  /** Обновляет createdAtMilliseconds своей записи, пока идёт установка Chromium */
  renew(): Promise<LoginLockRenewalResult>;
  release(): Promise<void>;
}

export type LoginLockState =
  | { kind: 'vacant' }
  | { kind: 'live'; record: LoginLockRecord }
  | { kind: 'stale'; rawContent: string; reason: string }
  | { kind: 'breaking' };

export type LockRaceStage =
  | 'before-link'
  | 'after-link'
  | 'before-break-verification'
  | 'after-stale-unlink'
  | 'before-renew-rename';

export interface LoginLockOptions {
  paths: StatePaths;
  timings: Pick<
    AuthenticationTimings,
    'lockStaleAgeMilliseconds' | 'lockBreakStaleAgeMilliseconds' | 'lockPollIntervalMilliseconds' | 'lockReleaseTimeoutMilliseconds'
  >;
  logger: AuthenticationLogger;
  clock?: Clock;
  isProcessAlive?: (processId: number) => boolean;
  /** Шов только для детерминированных тестов гонок */
  raceHook?: (stage: LockRaceStage) => Promise<void>;
}

interface LockOwnership {
  record: LoginLockRecord;
  exitHandler: () => void;
  released: boolean;
}

/* process.kill принимает только 32-битный PID со знаком, на большем он бросает не ESRCH, и процесс выглядел бы живым */
const MAXIMUM_PROCESS_ID = 0x7fffffff;
const LOCK_FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/* Пустая строка не разбирается как запись */
const UNREADABLE_LOCK_FILE_CONTENT = '';

/* Набор общий для всех экземпляров в процессе, иначе чужой экземпляр счёл бы живую свою запись брошенной */
const ownedLockNonces = new Set<string>();

function serializeRecord(record: LoginLockRecord): string {
  return JSON.stringify(record);
}

function parseRecord(rawContent: string): LoginLockRecord | undefined {
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(rawContent);
  } catch {
    return undefined;
  }
  if (typeof parsedContent !== 'object' || parsedContent === null) {
    return undefined;
  }
  const { processId, createdAtMilliseconds, nonce } = parsedContent as Record<string, unknown>;
  if (
    typeof processId !== 'number' ||
    !Number.isInteger(processId) ||
    processId <= 0 ||
    processId > MAXIMUM_PROCESS_ID ||
    typeof createdAtMilliseconds !== 'number' ||
    !Number.isFinite(createdAtMilliseconds) ||
    typeof nonce !== 'string' ||
    nonce.length === 0
  ) {
    return undefined;
  }
  return { processId, createdAtMilliseconds, nonce };
}

function describeErrorCode(error: unknown): string {
  return getErrorCode(error) ?? UNKNOWN_ERROR_CODE;
}

/**
 * FIFO, symlink или папка на месте файла блокировки читаются как нечитаемая запись: такую login.lock снимают как
 * устаревшую, а login.lock.break как брошенную. O_NONBLOCK не даёт открытию FIFO повесить вызов
 */
async function readOptionalFile(filePath: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, LOCK_FILE_OPEN_FLAGS);
  } catch (error) {
    const errorCode = getErrorCode(error);
    if (errorCode === FILE_SYSTEM_ERROR_CODES.NOT_FOUND) {
      return undefined;
    }
    if (errorCode === SYMBOLIC_LINK_LOOP_ERROR_CODE) {
      return UNREADABLE_LOCK_FILE_CONTENT;
    }
    throw error;
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile(TEXT_FILE_ENCODING) : UNREADABLE_LOCK_FILE_CONTENT;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Синхронный вариант readOptionalFile для обработчика exit; отсутствующий файл и symlink дают исключение */
function readLockFileSync(filePath: string): string {
  const descriptor = openSync(filePath, LOCK_FILE_OPEN_FLAGS);
  try {
    return fstatSync(descriptor).isFile() ? readFileSync(descriptor, TEXT_FILE_ENCODING) : UNREADABLE_LOCK_FILE_CONTENT;
  } finally {
    closeSync(descriptor);
  }
}

async function unlinkIgnoringMissing(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (getErrorCode(error) === FILE_SYSTEM_ERROR_CODES.NOT_FOUND) {
      return false;
    }
    throw error;
  }
}

/**
 * Пишет запись во временный файл и публикует её через link, поэтому файл блокировки никогда не бывает неполным
 * @returns false, если целевой файл уже существует
 */
async function writeRecordExclusively(targetPath: string, record: LoginLockRecord): Promise<boolean> {
  const temporaryPath = `${targetPath}.${record.nonce}${TEMPORARY_FILE_EXTENSION}`;
  try {
    await writeFile(temporaryPath, serializeRecord(record), { flag: EXCLUSIVE_CREATE_FLAG, mode: PRIVATE_FILE_MODE });
    try {
      await link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === FILE_SYSTEM_ERROR_CODES.ALREADY_EXISTS) {
        return false;
      }
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class LoginLock {
  private readonly paths: StatePaths;
  private readonly timings: LoginLockOptions['timings'];
  private readonly logger: AuthenticationLogger;
  private readonly clock: Clock;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly raceHook: LoginLockOptions['raceHook'];

  constructor(options: LoginLockOptions) {
    this.paths = options.paths;
    this.timings = options.timings;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.raceHook = options.raceHook;
  }

  async inspect(): Promise<LoginLockState> {
    const lockBreakRawContent = await readOptionalFile(this.paths.loginLockBreakPath);
    if (lockBreakRawContent !== undefined) {
      if (!this.isLockBreakStale(lockBreakRawContent)) {
        return { kind: 'breaking' };
      }
      if (!(await this.removeStaleLockBreak(lockBreakRawContent))) {
        return { kind: 'breaking' };
      }
    }

    const lockRawContent = await readOptionalFile(this.paths.loginLockPath);
    if (lockRawContent === undefined) {
      return { kind: 'vacant' };
    }
    const record = parseRecord(lockRawContent);
    if (record === undefined) {
      return { kind: 'stale', rawContent: lockRawContent, reason: 'unreadable record' };
    }
    const reason = this.describeStaleness(record);
    if (reason !== undefined) {
      return { kind: 'stale', rawContent: lockRawContent, reason };
    }
    return { kind: 'live', record };
  }

  async tryAcquire(): Promise<HeldLoginLock | undefined> {
    await ensureStateDirectory(this.paths);
    await this.raceHook?.('before-link');
    return this.publishOwnedLockRecord();
  }

  async tryBreakStale(state: Extract<LoginLockState, { kind: 'stale' }>): Promise<HeldLoginLock | undefined> {
    await ensureStateDirectory(this.paths);
    const lockBreakRecord = this.createRecord();
    if (!(await writeRecordExclusively(this.paths.loginLockBreakPath, lockBreakRecord))) {
      return undefined;
    }
    try {
      await this.raceHook?.('before-break-verification');
      const currentRawContent = await readOptionalFile(this.paths.loginLockPath);
      if (currentRawContent !== state.rawContent) {
        return undefined;
      }
      if (!(await unlinkIgnoringMissing(this.paths.loginLockPath))) {
        return undefined;
      }
      this.logger(`stale login lock removed (${state.reason})`);
      await this.raceHook?.('after-stale-unlink');
      /* Если файл уже есть, его успел создать обычный захват, и тот процесс единственный владелец */
      return await this.publishOwnedLockRecord();
    } finally {
      await this.removeOwnLockBreak(serializeRecord(lockBreakRecord));
    }
  }

  private createRecord(): LoginLockRecord {
    return { processId: process.pid, createdAtMilliseconds: this.clock.now(), nonce: randomUUID() };
  }

  /**
   * Публикует свою запись login.lock. Nonce попадает в набор до link: иначе другой экземпляр в этом процессе
   * между link и регистрацией увидит свой PID с неизвестным nonce и снимет живую запись как брошенную
   */
  private async publishOwnedLockRecord(): Promise<HeldLoginLock | undefined> {
    const record = this.createRecord();
    ownedLockNonces.add(record.nonce);
    let published = false;
    try {
      published = await writeRecordExclusively(this.paths.loginLockPath, record);
    } finally {
      if (!published) {
        ownedLockNonces.delete(record.nonce);
      }
    }
    if (!published) {
      return undefined;
    }
    await this.raceHook?.('after-link');
    return this.takeOwnership(record);
  }

  private describeStaleness(record: LoginLockRecord): string | undefined {
    if (!this.isProcessAlive(record.processId)) {
      return `holder process ${record.processId} not running`;
    }
    const ageMilliseconds = this.clock.now() - record.createdAtMilliseconds;
    if (ageMilliseconds > this.timings.lockStaleAgeMilliseconds) {
      return `age ${Math.floor(ageMilliseconds / MILLISECONDS_PER_SECOND)} s`;
    }
    if (record.processId === process.pid && !ownedLockNonces.has(record.nonce)) {
      return 'own process with unknown nonce';
    }
    return undefined;
  }

  private isLockBreakStale(rawContent: string): boolean {
    const record = parseRecord(rawContent);
    if (record === undefined) {
      return true;
    }
    const ageMilliseconds = this.clock.now() - record.createdAtMilliseconds;
    return (
      ageMilliseconds > this.timings.lockBreakStaleAgeMilliseconds ||
      ageMilliseconds < -this.timings.lockBreakStaleAgeMilliseconds
    );
  }

  /** @returns true, если брошенной вспомогательной блокировки больше нет */
  private async removeStaleLockBreak(observedRawContent: string): Promise<boolean> {
    const currentRawContent = await readOptionalFile(this.paths.loginLockBreakPath);
    if (currentRawContent === undefined) {
      return true;
    }
    if (currentRawContent !== observedRawContent) {
      return false;
    }
    await unlinkIgnoringMissing(this.paths.loginLockBreakPath);
    this.logger('stale lock break file removed');
    return true;
  }

  /** Никогда не бросает: вызывается из finally */
  private async removeOwnLockBreak(ownRawContent: string): Promise<void> {
    try {
      if ((await readOptionalFile(this.paths.loginLockBreakPath)) === ownRawContent) {
        await unlinkIgnoringMissing(this.paths.loginLockBreakPath);
      }
    } catch {
      /* Вспомогательная блокировка без живого владельца снимется по возрасту */
    }
  }

  /**
   * Берёт login.lock.break для release() и renew()
   * @returns сырое содержимое своей записи или undefined, если срок истёк
   */
  private async acquireLockBreak(deadlineMilliseconds: number): Promise<string | undefined> {
    while (this.clock.now() < deadlineMilliseconds) {
      const lockBreakRecord = this.createRecord();
      if (await writeRecordExclusively(this.paths.loginLockBreakPath, lockBreakRecord)) {
        return serializeRecord(lockBreakRecord);
      }
      const existingRawContent = await readOptionalFile(this.paths.loginLockBreakPath);
      if (existingRawContent === undefined) {
        continue;
      }
      if (this.isLockBreakStale(existingRawContent) && (await this.removeStaleLockBreak(existingRawContent))) {
        continue;
      }
      await this.clock.sleep(this.timings.lockPollIntervalMilliseconds);
    }
    return undefined;
  }

  /** Nonce записи уже зарегистрирован в publishOwnedLockRecord */
  private takeOwnership(record: LoginLockRecord): HeldLoginLock {
    const ownership: LockOwnership = {
      record,
      exitHandler: () => this.releaseOnExit(ownership),
      released: false,
    };
    process.on(PROCESS_EXIT_EVENT, ownership.exitHandler);
    return {
      get record() {
        return ownership.record;
      },
      renew: () => this.renew(ownership),
      release: () => this.release(ownership),
    };
  }

  private async release(ownership: LockOwnership): Promise<void> {
    ownership.released = true;
    const deadlineMilliseconds = this.clock.now() + this.timings.lockReleaseTimeoutMilliseconds;
    let lockBreakRawContent: string | undefined;
    try {
      lockBreakRawContent = await this.acquireLockBreak(deadlineMilliseconds);
      if (lockBreakRawContent === undefined) {
        this.logger('login lock release skipped, lock break busy');
        return;
      }
      const lockRawContent = await readOptionalFile(this.paths.loginLockPath);
      if (lockRawContent !== undefined && parseRecord(lockRawContent)?.nonce === ownership.record.nonce) {
        await unlinkIgnoringMissing(this.paths.loginLockPath);
      }
    } catch (error) {
      this.logger(`login lock release failed (${describeErrorCode(error)})`);
    } finally {
      if (lockBreakRawContent !== undefined) {
        await this.removeOwnLockBreak(lockBreakRawContent);
      }
      ownedLockNonces.delete(ownership.record.nonce);
      process.removeListener(PROCESS_EXIT_EVENT, ownership.exitHandler);
    }
  }

  /**
   * Запись обновляется под login.lock.break: снимающий сверяет сырое содержимое под той же блокировкой,
   * поэтому обновление видно ему либо до сверки, либо после снятия, когда nonce уже чужой
   */
  private async renew(ownership: LockOwnership): Promise<LoginLockRenewalResult> {
    /* release() мог оставить запись при занятой вспомогательной блокировке, и обновление оживило бы её */
    if (ownership.released) {
      return 'lost';
    }
    const deadlineMilliseconds = this.clock.now() + this.timings.lockReleaseTimeoutMilliseconds;
    let lockBreakRawContent: string | undefined;
    let temporaryPath: string | undefined;
    try {
      lockBreakRawContent = await this.acquireLockBreak(deadlineMilliseconds);
      if (lockBreakRawContent === undefined) {
        this.logger('login lock renewal skipped, lock break busy');
        return 'busy';
      }
      const lockRawContent = await readOptionalFile(this.paths.loginLockPath);
      if (
        ownership.released ||
        lockRawContent === undefined ||
        parseRecord(lockRawContent)?.nonce !== ownership.record.nonce
      ) {
        return 'lost';
      }
      const renewedRecord: LoginLockRecord = { ...ownership.record, createdAtMilliseconds: this.clock.now() };
      temporaryPath = `${this.paths.loginLockPath}.${renewedRecord.nonce}.${randomUUID()}.renew${TEMPORARY_FILE_EXTENSION}`;
      await writeFile(temporaryPath, serializeRecord(renewedRecord), {
        flag: EXCLUSIVE_CREATE_FLAG,
        mode: PRIVATE_FILE_MODE,
      });
      await this.raceHook?.('before-renew-rename');
      await rename(temporaryPath, this.paths.loginLockPath);
      ownership.record = renewedRecord;
      return 'renewed';
    } catch (error) {
      this.logger(`login lock renewal failed (${describeErrorCode(error)})`);
      return 'lost';
    } finally {
      if (temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      if (lockBreakRawContent !== undefined) {
        await this.removeOwnLockBreak(lockBreakRawContent);
      }
    }
  }

  /**
   * Синхронный и никогда не бросает: если обработчик exit бросит, Node не вызовет следующие обработчики,
   * среди них обработчик Playwright, который убивает Chromium
   */
  private releaseOnExit(ownership: LockOwnership): void {
    try {
      const { loginLockPath, loginLockBreakPath } = this.paths;
      const temporaryPath = `${loginLockBreakPath}.${ownership.record.nonce}.exit${TEMPORARY_FILE_EXTENSION}`;
      let ownsLockBreak = false;
      try {
        writeFileSync(temporaryPath, serializeRecord(this.createRecord()), {
          flag: EXCLUSIVE_CREATE_FLAG,
          mode: PRIVATE_FILE_MODE,
        });
        linkSync(temporaryPath, loginLockBreakPath);
        ownsLockBreak = true;
      } catch {
        /* Процесс мог прервать собственную критическую секцию снятия или release */
        try {
          ownsLockBreak = parseRecord(readLockFileSync(loginLockBreakPath))?.processId === process.pid;
        } catch {
          ownsLockBreak = false;
        }
      } finally {
        try {
          unlinkSync(temporaryPath);
        } catch {
          /* Временный файл мог не создаться, и процесс всё равно завершается */
        }
      }
      if (!ownsLockBreak) {
        return;
      }
      try {
        if (parseRecord(readLockFileSync(loginLockPath))?.nonce === ownership.record.nonce) {
          unlinkSync(loginLockPath);
        }
      } catch {
        /* Записи или папки уже нет: снимать нечего, а запись с мёртвым PID другие процессы снимут сами */
      }
      try {
        unlinkSync(loginLockBreakPath);
      } catch {
        /* Вспомогательная блокировка без живого владельца снимется по возрасту */
      }
    } catch {
      /* Обработчик exit не должен бросать, иначе Node не вызовет следующие обработчики */
    }
  }
}

#!/usr/bin/env node
/**
 * Проверка поставки: пакет собирается, пакуется, ставится в пустой каталог как чужой
 * пользователь и отвечает на tools/list.
 *
 * Почему именно так. Опубликованный пакет ломается не на сборке, а на стыках: забытый
 * файл в `files`, лишний файл в тарболе, потерянный shebang, бинарь без права на
 * исполнение, инструмент, который есть в коде, но не отдаётся сервером. Локальный
 * `npm test` эти стыки не видит, он работает с исходниками и с node_modules
 * разработчика. Поэтому проверка идёт через реальный тарбол и отдельный каталог установки.
 *
 * Сервер поднимается в браузерном режиме: без MATTERMOST_TOKEN, с адресом на закрытый
 * порт loopback и с HOME во временной папке. Окно входа не открывается и сеть не нужна,
 * потому что вход поднимается лениво, на первом вызове инструмента, а проверка вызывает
 * только initialize и tools/list. Отсутствие папки ~/.config/mattermost-mcp во временном
 * HOME после остановки подтверждает, что старт сервера ничего не пишет на диск.
 *
 * Эталон списка инструментов это массив tools из build/tools/index.js установленного
 * пакета. Расхождение между эталоном и живым ответом tools/list означает, что
 * инструмент объявлен, но не отдаётся сервером (или наоборот), и это провал с кодом 1.
 *
 * SDK 0.7.0 не отдаёт наружу дочерний процесс транспорта, а pid и сырой stdout проверке
 * нужны. Поэтому процесс берётся из приватного поля `_process` сразу после старта
 * транспорта. При обновлении SDK это место нужно пересмотреть первым.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const BINARY_NAME = 'mattermost-mcp';
const STARTUP_TIMEOUT_MILLISECONDS = 30_000;
const SHUTDOWN_TIMEOUT_MILLISECONDS = 5_000;
const TEMPORARY_DIRECTORY_PREFIX = 'mattermost-mcp-verify-';
const TEXT_ENCODING = 'utf8';

/* Закрытый порт на loopback: даже случайный запрос к API упадёт сразу, а не уйдёт в сеть */
const UNREACHABLE_MATTERMOST_URL = 'http://127.0.0.1:9/api/v4';
const VERIFICATION_TEAM_ID = 'verify-package';
const CLIENT_INFORMATION = { name: 'verify-package', version: '1.0.0' };
const EXPECTED_AUTHENTICATION_MODE_LINE = 'Auth mode: browser';
const STATE_DIRECTORY_SEGMENTS = ['.config', 'mattermost-mcp'];

const EXPECTED_SHEBANG = '#!/usr/bin/env node';
const BUILD_DIRECTORY_PREFIX = 'build/';
const ALLOWED_ROOT_FILES = new Set(['README.md', 'package.json', 'CHANGELOG.md']);
const EXECUTABLE_PERMISSION_BITS = 0o111;
const BINARY_TARGET_SEGMENTS = ['build', 'index.js'];
const TOOLS_MODULE_SEGMENTS = ['build', 'tools', 'index.js'];

const JSON_RPC_VERSION = '2.0';
const LINE_SEPARATOR = '\n';
const LINE_PREVIEW_LENGTH = 200;
const DATA_EVENT = 'data';
const EXIT_EVENT = 'exit';
const FORCED_KILL_SIGNAL = 'SIGKILL';
const SUSPICIOUS_STANDARD_ERROR_PATTERN = /error|fatal|failed|unauthori[sz]ed|ECONNREFUSED|ENOTFOUND|\[auth\]/i;

/** Каталоги, созданные проверкой: удаляются в finally, даже если проверка упала */
const temporaryDirectories = [];

function makeTemporaryDirectory(purpose) {
  const directory = mkdtempSync(join(tmpdir(), `${TEMPORARY_DIRECTORY_PREFIX}${purpose}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function run(command, commandArguments, options = {}) {
  return execFileSync(command, commandArguments, {
    encoding: TEXT_ENCODING,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function log(message) {
  process.stdout.write(`${message}${LINE_SEPARATOR}`);
}

function preview(line) {
  return line.length > LINE_PREVIEW_LENGTH ? `${line.slice(0, LINE_PREVIEW_LENGTH)}...` : line;
}

/**
 * Таймаут на шаг, завязанный на дочерний процесс: зависший сервер должен провалить
 * проверку, а не держать её бесконечно.
 */
function withTimeout(promise, milliseconds, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`превышен таймаут ${milliseconds} мс: ${label}`)), milliseconds);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function readPackageName() {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIRECTORY, 'package.json'), TEXT_ENCODING));
  return packageJson.name;
}

/** Пакует проект и возвращает путь к тарболу и список файлов с правами из отчёта npm pack */
function packTarball(packDirectory) {
  const rawOutput = run('npm', ['pack', '--json', '--pack-destination', packDirectory], { cwd: ROOT_DIRECTORY });
  /* npm может дописать в stdout служебные строки, JSON начинается с первой скобки массива */
  const jsonStart = rawOutput.indexOf('[');
  if (jsonStart < 0) {
    throw new Error(`npm pack не вернул JSON: ${rawOutput}`);
  }
  const [report] = JSON.parse(rawOutput.slice(jsonStart));
  if (typeof report?.filename !== 'string' || !Array.isArray(report.files)) {
    throw new Error('npm pack не сообщил имя тарбола или список файлов');
  }
  return { tarball: join(packDirectory, report.filename), files: report.files };
}

/** Состав тарбола: только build, README.md, package.json и CHANGELOG.md, если он появился */
function findTarballProblems(files) {
  const problems = [];
  const unexpectedFiles = files
    .map((file) => file.path)
    .filter((path) => !path.startsWith(BUILD_DIRECTORY_PREFIX) && !ALLOWED_ROOT_FILES.has(path));
  if (unexpectedFiles.length > 0) {
    problems.push(`лишние файлы в тарболе: ${unexpectedFiles.join(', ')}`);
  }

  const binaryTargetPath = BINARY_TARGET_SEGMENTS.join('/');
  const binaryTarget = files.find((file) => file.path === binaryTargetPath);
  if (binaryTarget === undefined) {
    problems.push(`в тарболе нет ${binaryTargetPath}`);
  } else if ((binaryTarget.mode & EXECUTABLE_PERMISSION_BITS) === 0) {
    problems.push(`${binaryTargetPath} в тарболе без права на исполнение (mode ${binaryTarget.mode.toString(8)})`);
  }
  return problems;
}

function installTarball(installDirectory, tarball) {
  run('npm', ['init', '-y'], { cwd: installDirectory });
  run('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: installDirectory,
    env: {
      ...process.env,
      /*
       * Сейчас у playwright нет install-скрипта, но Chromium весит сотни мегабайт, и
       * проверке поставки он не нужен ни при каком будущем обновлении.
       */
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });
}

/** Бинарь из node_modules/.bin: shebang и право на исполнение у файла, на который он указывает */
function findBinaryProblems(binary) {
  if (!existsSync(binary)) {
    return [`бинарь не появился после установки: ${binary}`];
  }
  const problems = [];
  const binaryTarget = realpathSync(binary);
  const firstLine = readFileSync(binaryTarget, TEXT_ENCODING).split(LINE_SEPARATOR, 1)[0];
  if (firstLine !== EXPECTED_SHEBANG) {
    problems.push(`первая строка ${binaryTarget} не shebang: ${preview(firstLine)}`);
  }
  try {
    accessSync(binaryTarget, constants.X_OK);
  } catch {
    problems.push(`у ${binaryTarget} нет права на исполнение`);
  }
  return problems;
}

/**
 * Каждая завершённая строка stdout обязана быть JSON-RPC сообщением, а хвоста без
 * перевода строки быть не должно: любой console.log в stdout ломает протокол у клиента.
 */
function findStandardOutputProblems(standardOutputText) {
  const lines = standardOutputText.split(LINE_SEPARATOR);
  const trailingText = lines.pop();
  const problems = [];
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    if (message?.jsonrpc !== JSON_RPC_VERSION) {
      problems.push(`не JSON-RPC строка: ${preview(line)}`);
    }
  }
  if (trailingText !== '') {
    problems.push(`хвост без перевода строки: ${preview(trailingText)}`);
  }
  return problems;
}

function waitForExit(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => childProcess.once(EXIT_EVENT, () => resolve()));
}

async function listToolsFromInstalledBinary(binary, installDirectory, homeDirectory) {
  const transport = new StdioClientTransport({
    command: binary,
    cwd: installDirectory,
    env: {
      ...getDefaultEnvironment(),
      /* Подменённый дом: ни профиль, ни токен, ни Chromium пользователя проверка не трогает */
      HOME: homeDirectory,
      MATTERMOST_URL: UNREACHABLE_MATTERMOST_URL,
      MATTERMOST_TEAM_ID: VERIFICATION_TEAM_ID,
    },
    stderr: 'pipe',
  });

  const standardOutputChunks = [];
  const standardErrorChunks = [];
  let childProcess = null;

  const startTransport = transport.start.bind(transport);
  transport.start = async () => {
    await startTransport();
    childProcess = transport._process;
    /* Слушатель ставится до первого запроса клиента, поэтому ответ на initialize тоже попадает сюда */
    childProcess.stdout.on(DATA_EVENT, (chunk) => standardOutputChunks.push(chunk));
    childProcess.stderr.on(DATA_EVENT, (chunk) => standardErrorChunks.push(chunk));
  };

  const client = new Client(CLIENT_INFORMATION, { capabilities: {} });
  let toolNames;
  try {
    await withTimeout(client.connect(transport), STARTUP_TIMEOUT_MILLISECONDS, 'подключение к серверу');
    const listed = await withTimeout(client.listTools(), STARTUP_TIMEOUT_MILLISECONDS, 'запрос tools/list');
    toolNames = listed.tools.map((tool) => tool.name);
  } finally {
    /* close в SDK 0.7.0 прерывает процесс через AbortSignal, то есть шлёт SIGTERM своему дочернему процессу */
    await client.close();
    if (childProcess !== null) {
      try {
        /* Событие exit, а не проба PID: номер завершённого процесса может уже достаться чужому */
        await withTimeout(waitForExit(childProcess), SHUTDOWN_TIMEOUT_MILLISECONDS, 'остановка сервера после close');
      } catch (error) {
        /* Мусор в системе хуже упавшей проверки: зависший дочерний процесс добивается, и проверка падает */
        childProcess.kill(FORCED_KILL_SIGNAL);
        throw error;
      }
    }
  }

  return {
    toolNames,
    processId: childProcess.pid,
    standardOutputText: Buffer.concat(standardOutputChunks).toString(TEXT_ENCODING),
    standardErrorText: Buffer.concat(standardErrorChunks).toString(TEXT_ENCODING),
  };
}

function reportResult(problems) {
  log('');
  if (problems.length > 0) {
    for (const problem of problems) {
      log(`ПРОБЛЕМА: ${problem}`);
    }
    log('ПРОВЕРКА ПОСТАВКИ ПРОВАЛЕНА');
    process.exitCode = 1;
    return;
  }
  log('ПРОВЕРКА ПОСТАВКИ ПРОЙДЕНА');
}

async function main() {
  log('сборка пакета');
  run('npm', ['run', 'build'], { cwd: ROOT_DIRECTORY });

  const packDirectory = makeTemporaryDirectory('pack');
  const installDirectory = makeTemporaryDirectory('install');
  const homeDirectory = makeTemporaryDirectory('home');

  const { tarball, files } = packTarball(packDirectory);
  log(`тарбол: ${tarball}, файлов: ${files.length}`);
  const problems = findTarballProblems(files);

  log('чистая установка тарбола');
  installTarball(installDirectory, tarball);
  const installedPackageDirectory = join(installDirectory, 'node_modules', ...readPackageName().split('/'));
  const binary = join(installDirectory, 'node_modules', '.bin', BINARY_NAME);
  const binaryProblems = findBinaryProblems(binary);
  if (binaryProblems.length > 0) {
    /* Без shebang или права на исполнение запуск упадёт с ENOEXEC и спрячет настоящую причину */
    reportResult([...problems, ...binaryProblems]);
    return;
  }

  log('запуск установленного бинаря по stdio и запрос tools/list');
  const { toolNames, processId, standardOutputText, standardErrorText } = await listToolsFromInstalledBinary(
    binary,
    installDirectory,
    homeDirectory,
  );

  /* Эталон берётся из установленного пакета, а не из исходников: сверяем то, что реально уехало к пользователю */
  const toolsModuleUrl = pathToFileURL(join(installedPackageDirectory, ...TOOLS_MODULE_SEGMENTS)).href;
  const { tools } = await import(toolsModuleUrl);
  const expected = new Set(tools.map((tool) => tool.name));
  const actual = new Set(toolNames);
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length > 0) {
    problems.push(`нет в tools/list, но есть в build/tools/index.js: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`есть в tools/list, но нет в build/tools/index.js: ${extra.join(', ')}`);
  }
  if (toolNames.length !== actual.size) {
    problems.push(`в tools/list есть повторяющиеся имена: ${toolNames.join(', ')}`);
  }

  problems.push(...findStandardOutputProblems(standardOutputText).map((problem) => `stdout сервера: ${problem}`));

  const standardErrorLines = standardErrorText.split(LINE_SEPARATOR).filter((line) => line.trim().length > 0);
  if (!standardErrorLines.some((line) => line.startsWith(EXPECTED_AUTHENTICATION_MODE_LINE))) {
    problems.push(`сервер стартовал не в браузерном режиме: в stderr нет строки "${EXPECTED_AUTHENTICATION_MODE_LINE}"`);
  }
  /* Старт без токена обязан пройти молча по части ошибок: сеть и вход тут не поднимаются */
  for (const line of standardErrorLines.filter((line) => SUSPICIOUS_STANDARD_ERROR_PATTERN.test(line))) {
    problems.push(`подозрительная строка stderr сервера: ${preview(line)}`);
  }

  const stateDirectory = join(homeDirectory, ...STATE_DIRECTORY_SEGMENTS);
  if (existsSync(stateDirectory)) {
    problems.push(`сервер создал папку состояния без вызова инструментов: ${stateDirectory}`);
  }

  log('');
  log(`инструментов в ответе: ${actual.size}, ожидалось: ${expected.size}`);
  log(`ответившие инструменты: ${[...actual].join(', ')}`);
  log(`строк в stdout сервера: ${standardOutputText.split(LINE_SEPARATOR).length - 1}`);
  log(`stderr сервера:${LINE_SEPARATOR}${standardErrorLines.map((line) => `  ${line}`).join(LINE_SEPARATOR)}`);
  log(`процесс сервера ${processId} завершён`);

  reportResult(problems);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`проверка поставки упала: ${error instanceof Error ? error.stack : String(error)}${LINE_SEPARATOR}`);
  process.exitCode = 1;
} finally {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
}

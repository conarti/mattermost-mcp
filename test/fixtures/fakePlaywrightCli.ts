/**
 * Заменяет cli.js Playwright в дочерних процессах тестов: ничего не скачивает и не обращается к сети.
 * Режим берётся из переменной PLAYWRIGHT_CLI_FIXTURE_VARIABLES.MODE.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { PLAYWRIGHT_CLI_FIXTURE_MODES, PLAYWRIGHT_CLI_FIXTURE_VARIABLES } from './fixtureConstants.js';

const PROGRESS_BAR_WIDTH = 80;
const CHROMIUM_DOWNLOAD_TITLE = 'Chrome for Testing 153.0.8010.12 (playwright chromium v1243)';
const CHROMIUM_DOWNLOAD_URL = 'https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip';
const CHROMIUM_ARCHIVE_SIZE_DESCRIPTION = '182.1 MiB';
const FFMPEG_DOWNLOAD_TITLE = 'FFmpeg (playwright ffmpeg v1011)';
const FFMPEG_DOWNLOAD_URL = 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-mac-arm64.zip';
const FFMPEG_ARCHIVE_SIZE_DESCRIPTION = '1 MiB';

function buildProgressLine(percent: number, totalSizeDescription: string): string {
  const filledWidth = Math.floor((PROGRESS_BAR_WIDTH * percent) / 100);
  return `|${'■'.repeat(filledWidth)}${' '.repeat(PROGRESS_BAR_WIDTH - filledWidth)}| ${String(percent).padStart(3)}% of ${totalSizeDescription}`;
}

/** Вывод Playwright 1.63.0 без TTY для одного архива: logPolitely до и после построчного прогресса */
function writeArchiveDownload(title: string, url: string, directoryName: string, percents: number[], totalSizeDescription: string): void {
  process.stdout.write(`Downloading ${title} from ${url}\n`);
  for (const percent of percents) {
    process.stdout.write(`${buildProgressLine(percent, totalSizeDescription)}\n`);
  }
  process.stdout.write(`${title} downloaded to ${join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '', directoryName)}\n`);
}

const mode = process.env[PLAYWRIGHT_CLI_FIXTURE_VARIABLES.MODE];

if (mode === PLAYWRIGHT_CLI_FIXTURE_MODES.SUCCESS) {
  writeArchiveDownload(CHROMIUM_DOWNLOAD_TITLE, CHROMIUM_DOWNLOAD_URL, 'chromium-1243', [10, 40, 100], CHROMIUM_ARCHIVE_SIZE_DESCRIPTION);
  writeArchiveDownload(FFMPEG_DOWNLOAD_TITLE, FFMPEG_DOWNLOAD_URL, 'ffmpeg-1011', [0, 50, 100], FFMPEG_ARCHIVE_SIZE_DESCRIPTION);
  process.stderr.write(
    [
      '╔══════════════════════════════════════════════════════════════════════════════╗',
      "║ WARNING: It looks like you are running 'npx playwright install' without first ║",
      "║ installing your project's dependencies.                                       ║",
      '╚══════════════════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n'),
  );
  const recordPath = process.env[PLAYWRIGHT_CLI_FIXTURE_VARIABLES.RECORD_PATH];
  if (recordPath !== undefined) {
    writeFileSync(
      recordPath,
      JSON.stringify({
        commandArguments: process.argv.slice(2),
        browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
        temporaryDirectoryVariable: process.env.TMPDIR,
        operatingSystemTemporaryDirectory: tmpdir(),
      }),
    );
  }
  const partialDownloadDirectory = join(tmpdir(), 'playwright-download-fake');
  mkdirSync(partialDownloadDirectory, { recursive: true });
  writeFileSync(join(partialDownloadDirectory, 'partial.zip'), 'partial archive');
  process.exitCode = 0;
} else if (mode === PLAYWRIGHT_CLI_FIXTURE_MODES.FAILURE) {
  const networkError = Object.assign(new Error('getaddrinfo ENOTFOUND cdn.playwright.dev'), {
    errno: -3008,
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'cdn.playwright.dev',
  });
  /* Внук установщика печатает ошибку через console.error: после стека идёт блок свойств */
  process.stderr.write(`${inspect(networkError)}\n`);
  process.stdout.write('Failed to install browsers\nError: Download failure, code=1\n');
  process.exitCode = 1;
} else if (mode === PLAYWRIGHT_CLI_FIXTURE_MODES.HANG) {
  const processIdPath = process.env[PLAYWRIGHT_CLI_FIXTURE_VARIABLES.PROCESS_ID_PATH];
  if (processIdPath !== undefined) {
    writeFileSync(processIdPath, String(process.pid));
  }
  process.stdout.write(`Downloading ${CHROMIUM_DOWNLOAD_TITLE} from ${CHROMIUM_DOWNLOAD_URL}\n`);
  process.stdout.write(`${buildProgressLine(10, CHROMIUM_ARCHIVE_SIZE_DESCRIPTION)}\n`);
  setInterval(() => undefined, 1_000_000);
} else {
  process.stderr.write(`unknown fake Playwright CLI mode ${mode}\n`);
  process.exitCode = 2;
}

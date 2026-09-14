/**
 * Заменяет cli.js Playwright в дочерних процессах тестов: ничего не скачивает и не обращается к сети.
 * Режим берётся из FAKE_PLAYWRIGHT_CLI_MODE.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROGRESS_BAR_WIDTH = 80;

function buildProgressLine(percent: number): string {
  const filledWidth = Math.floor((PROGRESS_BAR_WIDTH * percent) / 100);
  return `|${'■'.repeat(filledWidth)}${' '.repeat(PROGRESS_BAR_WIDTH - filledWidth)}| ${String(percent).padStart(3)}% of 150.3 MiB`;
}

const mode = process.env.FAKE_PLAYWRIGHT_CLI_MODE;

if (mode === 'success') {
  process.stdout.write('Downloading Chromium 153.0.8010.12 from https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip\n');
  for (const percent of [10, 40, 100]) {
    process.stdout.write(`${buildProgressLine(percent)}\n`);
  }
  process.stderr.write(
    [
      '╔══════════════════════════════════════════════════════════════════════════════╗',
      "║ WARNING: It looks like you are running 'npx playwright install' without first ║",
      "║ installing your project's dependencies.                                       ║",
      '╚══════════════════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n'),
  );
  const recordPath = process.env.FAKE_PLAYWRIGHT_CLI_RECORD_PATH;
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
} else if (mode === 'failure') {
  process.stderr.write('Error: getaddrinfo ENOTFOUND cdn.playwright.dev\n    at GetAddrInfoReqWrap.onlookupall (node:dns:120:26)\n');
  process.stdout.write('Failed to install browsers\nError: Download failure, code=1\n');
  process.exitCode = 1;
} else if (mode === 'hang') {
  const processIdPath = process.env.FAKE_PLAYWRIGHT_CLI_PID_PATH;
  if (processIdPath !== undefined) {
    writeFileSync(processIdPath, String(process.pid));
  }
  process.stdout.write(`${buildProgressLine(10)}\n`);
  setInterval(() => undefined, 1_000_000);
} else {
  process.stderr.write(`unknown fake Playwright CLI mode ${mode}\n`);
  process.exitCode = 2;
}

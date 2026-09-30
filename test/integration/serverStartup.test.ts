import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  AUTHENTICATION_LOG_PREFIX,
  AUTHENTICATION_MODES,
  AUTHENTICATION_MODE_LOG_PREFIX,
  DATA_EVENT,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PROCESS_EXIT_EVENT,
  SERVER_SHUTDOWN_MESSAGE,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { tools } from '../../src/tools/index.js';
import {
  FIXTURE_INTERRUPT_SIGNAL,
  FIXTURE_KILL_SIGNAL,
  FIXTURE_MATTERMOST_URL,
  FIXTURE_TEAM_ID,
  FIXTURE_TERMINATION_SIGNAL,
  OUTPUT_LINE_SEPARATOR,
} from '../fixtures/fixtureConstants.js';
import { assertNoSecrets } from '../fixtures/captureLogs.js';
import { environmentWithout, removeDirectories } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 30_000;
const STATIC_TOKEN = 'static-secret-token-0001';
const TOOLS_LIST_REQUEST_ID = 2;
const EXPECTED_TOOL_COUNT = 13;
const UNENCRYPTED_URL_WARNING_FRAGMENT = 'sent without encryption';
/* Сервер не обращается к адресу до вызова инструмента, поэтому несуществующий хост не даёт сетевых запросов */
const UNENCRYPTED_REMOTE_MATTERMOST_URL = 'http://chat.example.test/api/v4';

const temporaryDirectories: string[] = [];
const startedServers: ChildProcessWithoutNullStreams[] = [];

after(async () => {
  /* Сигнал только по PID своего дочернего сервера, если тест упал до его завершения */
  for (const server of startedServers) {
    if (server.exitCode === null && server.signalCode === null && server.pid !== undefined) {
      process.kill(server.pid, FIXTURE_KILL_SIGNAL);
    }
  }
  await removeDirectories(temporaryDirectories);
});

interface JsonRpcMessage {
  id?: number;
  result?: { tools?: Array<{ name: string }> };
}

interface ServerRun {
  standardOutputLines: string[];
  /** Строки stdout, которые не разобрались как JSON, с текстом ошибки разбора */
  standardOutputParseErrors: string[];
  standardError: string;
  toolNames: string[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

/** Сервер из build-test: для build/index.js конфиг нашёл бы отслеживаемый config.json с плейсхолдером токена */
async function runServerUntilToolsList(
  homeDirectory: string,
  token: string | undefined,
  stopSignal: NodeJS.Signals = FIXTURE_TERMINATION_SIGNAL,
  mattermostUrl: string = FIXTURE_MATTERMOST_URL,
): Promise<ServerRun> {
  const serverPath = fileURLToPath(new URL('../../src/index.js', import.meta.url));
  const environment: NodeJS.ProcessEnv = {
    ...environmentWithout('MATTERMOST_TOKEN', PLAYWRIGHT_BROWSERS_PATH_VARIABLE),
    HOME: homeDirectory,
    MATTERMOST_URL: mattermostUrl,
    MATTERMOST_TEAM_ID: FIXTURE_TEAM_ID,
  };
  if (token !== undefined) {
    environment.MATTERMOST_TOKEN = token;
  }

  const server = spawn(process.execPath, [serverPath], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  startedServers.push(server);

  let pendingStandardOutput = '';
  const standardOutputLines: string[] = [];
  const standardOutputParseErrors: string[] = [];
  let standardError = '';
  server.stdout.setEncoding(TEXT_FILE_ENCODING);
  server.stderr.setEncoding(TEXT_FILE_ENCODING);
  server.stderr.on(DATA_EVENT, (chunk: string) => {
    standardError += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    server.once(PROCESS_EXIT_EVENT, (code, signal) => resolve({ code, signal }));
  });
  const toolsListResponse = new Promise<JsonRpcMessage>((resolve, reject) => {
    /* Исключение в обработчике data уронило бы процесс теста, поэтому ошибки разбора копятся и проверяются assert */
    server.stdout.on(DATA_EVENT, (chunk: string) => {
      const lines = `${pendingStandardOutput}${chunk}`.split(OUTPUT_LINE_SEPARATOR);
      pendingStandardOutput = lines.pop() ?? '';
      for (const line of lines.filter((outputLine) => outputLine !== '')) {
        standardOutputLines.push(line);
        let message: JsonRpcMessage | null;
        try {
          message = JSON.parse(line) as JsonRpcMessage | null;
        } catch (error) {
          standardOutputParseErrors.push(`${error instanceof Error ? error.message : String(error)}: ${line}`);
          continue;
        }
        if (message?.id === TOOLS_LIST_REQUEST_ID) {
          resolve(message);
        }
      }
    });
    void exited.then(({ code, signal }) =>
      reject(
        new Error(
          `server exited before tools/list (code ${code}, signal ${signal})\nstdout parse errors:\n${standardOutputParseErrors.join('\n')}\nstderr:\n${standardError}`,
        ),
      ),
    );
  });

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'server-startup-test', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: TOOLS_LIST_REQUEST_ID, method: 'tools/list' },
  ];
  for (const request of requests) {
    server.stdin.write(`${JSON.stringify(request)}${OUTPUT_LINE_SEPARATOR}`);
  }

  const response = await toolsListResponse;
  const toolNames = (response.result?.tools ?? []).map((tool) => tool.name);

  /* stdin остаётся открытым: процесс завершает только сигнал */
  assert.ok(server.pid !== undefined);
  process.kill(server.pid, stopSignal);
  const { code, signal } = await exited;
  server.stdin.destroy();
  if (pendingStandardOutput !== '') {
    standardOutputLines.push(pendingStandardOutput);
    standardOutputParseErrors.push(`line without a trailing line separator: ${pendingStandardOutput}`);
  }

  return {
    standardOutputLines,
    standardOutputParseErrors,
    standardError,
    toolNames,
    exitCode: code,
    exitSignal: signal,
  };
}

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-server-startup-'));
  temporaryDirectories.push(directory);
  return directory;
}

function assertOnlyJsonRpcOnStandardOutput(run: ServerRun): void {
  assert.deepEqual(run.standardOutputParseErrors, [], `stdout has lines that are not JSON-RPC messages\nstderr:\n${run.standardError}`);
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

test(
  'U1: browser mode lists 9 tools without creating the state directory and exits with code 0 on SIGTERM',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const homeDirectory = await createTemporaryHome();

    const run = await runServerUntilToolsList(homeDirectory, undefined);

    assert.equal(run.toolNames.length, EXPECTED_TOOL_COUNT);
    assert.deepEqual(run.toolNames, tools.map((tool) => tool.name));
    assert.equal(existsSync(resolveStatePaths(homeDirectory).stateDirectory), false);
    assert.ok(run.standardError.includes(`${AUTHENTICATION_MODE_LOG_PREFIX} ${AUTHENTICATION_MODES.BROWSER}`), run.standardError);
    assert.equal(run.standardError.includes(UNENCRYPTED_URL_WARNING_FRAGMENT), false, run.standardError);
    assertOnlyJsonRpcOnStandardOutput(run);
    assert.equal(run.exitSignal, null, run.standardError);
    assert.equal(run.exitCode, 0, run.standardError);
  },
);

test(
  'U2: static mode logs the mode without the token value and is terminated by SIGTERM as in 1.1.2',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const homeDirectory = await createTemporaryHome();

    const run = await runServerUntilToolsList(homeDirectory, STATIC_TOKEN);

    assert.equal(run.toolNames.length, EXPECTED_TOOL_COUNT);
    assert.ok(run.standardError.includes(`${AUTHENTICATION_MODE_LOG_PREFIX} ${AUTHENTICATION_MODES.STATIC}`), run.standardError);
    assertNoSecrets(run.standardError.split(OUTPUT_LINE_SEPARATOR), [STATIC_TOKEN]);
    assertNoSecrets(run.standardOutputLines, [STATIC_TOKEN]);
    assert.equal(existsSync(resolveStatePaths(homeDirectory).stateDirectory), false);
    assertOnlyJsonRpcOnStandardOutput(run);
    assert.equal(run.exitSignal, FIXTURE_TERMINATION_SIGNAL);
  },
);

test(
  'U3: SIGINT prints the shutdown line once and exits with code 0 in browser and static modes',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    for (const token of [undefined, STATIC_TOKEN]) {
      const homeDirectory = await createTemporaryHome();

      const run = await runServerUntilToolsList(homeDirectory, token, FIXTURE_INTERRUPT_SIGNAL);

      assert.equal(countOccurrences(run.standardError, SERVER_SHUTDOWN_MESSAGE), 1, run.standardError);
      assertOnlyJsonRpcOnStandardOutput(run);
      assert.equal(run.exitSignal, null, run.standardError);
      assert.equal(run.exitCode, 0, run.standardError);
    }
  },
);

test(
  'U4: browser mode warns once about an http MATTERMOST_URL outside loopback, static mode does not',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const browserRun = await runServerUntilToolsList(
      await createTemporaryHome(),
      undefined,
      FIXTURE_TERMINATION_SIGNAL,
      UNENCRYPTED_REMOTE_MATTERMOST_URL,
    );
    const warningLines = browserRun.standardError
      .split(OUTPUT_LINE_SEPARATOR)
      .filter((line) => line.includes(UNENCRYPTED_URL_WARNING_FRAGMENT));
    assert.equal(warningLines.length, 1, browserRun.standardError);
    assert.ok(warningLines[0].startsWith(`${AUTHENTICATION_LOG_PREFIX} MATTERMOST_URL uses http:// for chat.example.test`), warningLines[0]);
    assert.equal(browserRun.toolNames.length, EXPECTED_TOOL_COUNT);
    assertOnlyJsonRpcOnStandardOutput(browserRun);
    assert.equal(browserRun.exitCode, 0, browserRun.standardError);

    const staticRun = await runServerUntilToolsList(
      await createTemporaryHome(),
      STATIC_TOKEN,
      FIXTURE_TERMINATION_SIGNAL,
      UNENCRYPTED_REMOTE_MATTERMOST_URL,
    );
    assert.equal(staticRun.standardError.includes(UNENCRYPTED_URL_WARNING_FRAGMENT), false, staticRun.standardError);
    assert.equal(staticRun.toolNames.length, EXPECTED_TOOL_COUNT);
  },
);

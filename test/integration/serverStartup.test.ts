import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { DATA_EVENT, PROCESS_EXIT_EVENT, TEXT_FILE_ENCODING } from '../../src/authentication/constants.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { tools } from '../../src/tools/index.js';
import {
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
const EXPECTED_TOOL_COUNT = 9;

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
  standardError: string;
  toolNames: string[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

/** Сервер из build-test: для build/index.js конфиг нашёл бы отслеживаемый config.json с плейсхолдером токена */
async function runServerUntilToolsList(homeDirectory: string, token: string | undefined): Promise<ServerRun> {
  const serverPath = fileURLToPath(new URL('../../src/index.js', import.meta.url));
  const environment: NodeJS.ProcessEnv = {
    ...environmentWithout('MATTERMOST_TOKEN', 'PLAYWRIGHT_BROWSERS_PATH'),
    HOME: homeDirectory,
    MATTERMOST_URL: FIXTURE_MATTERMOST_URL,
    MATTERMOST_TEAM_ID: FIXTURE_TEAM_ID,
  };
  if (token !== undefined) {
    environment.MATTERMOST_TOKEN = token;
  }

  const server = spawn(process.execPath, [serverPath], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  startedServers.push(server);

  let standardOutput = '';
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
    server.stdout.on(DATA_EVENT, (chunk: string) => {
      standardOutput += chunk;
      const completeOutput = standardOutput.slice(0, standardOutput.lastIndexOf(OUTPUT_LINE_SEPARATOR) + 1);
      for (const line of completeOutput.split(OUTPUT_LINE_SEPARATOR).filter((outputLine) => outputLine !== '')) {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id === TOOLS_LIST_REQUEST_ID) {
          resolve(message);
        }
      }
    });
    void exited.then(({ code, signal }) =>
      reject(new Error(`server exited before tools/list (code ${code}, signal ${signal})\nstderr:\n${standardError}`)),
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
  process.kill(server.pid, FIXTURE_TERMINATION_SIGNAL);
  const { code, signal } = await exited;
  server.stdin.destroy();

  return {
    standardOutputLines: standardOutput.split(OUTPUT_LINE_SEPARATOR).filter((line) => line !== ''),
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

function assertOnlyJsonRpcOnStandardOutput(lines: readonly string[]): void {
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), line);
  }
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
    assert.ok(run.standardError.includes('Auth mode: browser'), run.standardError);
    assertOnlyJsonRpcOnStandardOutput(run.standardOutputLines);
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
    assert.ok(run.standardError.includes('Auth mode: static'), run.standardError);
    assertNoSecrets(run.standardError.split(OUTPUT_LINE_SEPARATOR), [STATIC_TOKEN]);
    assertNoSecrets(run.standardOutputLines, [STATIC_TOKEN]);
    assert.equal(existsSync(resolveStatePaths(homeDirectory).stateDirectory), false);
    assertOnlyJsonRpcOnStandardOutput(run.standardOutputLines);
    assert.equal(run.exitSignal, FIXTURE_TERMINATION_SIGNAL);
  },
);

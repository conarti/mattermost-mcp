import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, describeUnencryptedMattermostUrl, resolveAuthenticationMode, validateConfig } from '../src/config.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const TEAM_ID = 'team-test';

function createConfig(overrides: Partial<Config>): Config {
  return { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID, ...overrides };
}

test('F1: validateConfig does not require a token but still requires the url and the team id', (t) => {
  const exitMock = t.mock.method(process, 'exit', () => undefined);
  const errorMock = t.mock.method(console, 'error', () => undefined);

  validateConfig(createConfig({ token: '' }));
  assert.equal(exitMock.mock.callCount(), 0);
  assert.equal(errorMock.mock.callCount(), 0);

  validateConfig(createConfig({ mattermostUrl: '' }));
  assert.equal(exitMock.mock.callCount(), 1);
  assert.deepEqual(exitMock.mock.calls[0].arguments, [1]);
  const printedLines = errorMock.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(printedLines.some((line) => line.includes('mattermostUrl')));
  assert.equal(printedLines.some((line) => line.includes('token (--token')), false);

  errorMock.mock.resetCalls();
  validateConfig(createConfig({ teamId: '' }));
  assert.equal(exitMock.mock.callCount(), 2);
  assert.deepEqual(exitMock.mock.calls[1].arguments, [1]);
  const teamIdLines = errorMock.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(teamIdLines.some((line) => line.includes('teamId (--team-id or MATTERMOST_TEAM_ID)')));
  assert.equal(teamIdLines.some((line) => line.includes('mattermostUrl')), false);
  assert.equal(teamIdLines.some((line) => line.includes('token (--token')), false);
});

test('F2: an empty token selects browser mode and any other token selects static mode', () => {
  assert.equal(resolveAuthenticationMode(createConfig({ token: '' })), 'browser');
  assert.equal(resolveAuthenticationMode(createConfig({ token: 'abc' })), 'static');
  assert.equal(resolveAuthenticationMode(createConfig({ token: '   ' })), 'static');
  assert.equal(resolveAuthenticationMode(createConfig({ token: 'true' })), 'static');
});

test('F3: an http MATTERMOST_URL outside loopback is described as unencrypted', () => {
  for (const unencryptedUrl of ['http://chat.example.test/api/v4', 'HTTP://Chat.Example.test:8065/api/v4', 'http://10.0.0.5/api/v4']) {
    const warning = describeUnencryptedMattermostUrl(unencryptedUrl);
    assert.ok(warning !== undefined, unencryptedUrl);
    assert.ok(warning.includes('sent without encryption'), warning);
    assert.ok(warning.includes(new URL(unencryptedUrl).hostname), warning);
  }
  for (const safeUrl of [
    'https://chat.example.test/api/v4',
    'http://localhost:8065/api/v4',
    'http://127.0.0.1:9/api/v4',
    'http://[::1]:8065/api/v4',
    'not a url',
  ]) {
    assert.equal(describeUnencryptedMattermostUrl(safeUrl), undefined, safeUrl);
  }
});

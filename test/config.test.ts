import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, resolveAuthenticationMode, validateConfig } from '../src/config.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const TEAM_ID = 'team-test';

function createConfig(overrides: Partial<Config>): Config {
  return { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID, ...overrides };
}

test('F1: validateConfig does not require a token but still requires the url', (t) => {
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
});

test('F2: an empty token selects browser mode and any other token selects static mode', () => {
  assert.equal(resolveAuthenticationMode(createConfig({ token: '' })), 'browser');
  assert.equal(resolveAuthenticationMode(createConfig({ token: 'abc' })), 'static');
  assert.equal(resolveAuthenticationMode(createConfig({ token: '   ' })), 'static');
  assert.equal(resolveAuthenticationMode(createConfig({ token: 'true' })), 'static');
});

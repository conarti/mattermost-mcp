import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidMattermostId } from '../../src/tools/mattermostId.js';

const VALID_ID = 'abcdefghijklmnopqrstuvwxyz';

test('I1: only a 26-character id of lowercase letters and digits is valid', () => {
  assert.equal(VALID_ID.length, 26);
  assert.equal(isValidMattermostId(VALID_ID), true);
  assert.equal(isValidMattermostId('0123456789abcdefghijklmnop'), true);

  for (const invalidId of ['../x', VALID_ID.toUpperCase(), VALID_ID.slice(1), `${VALID_ID}a`, '', `../${VALID_ID.slice(3)}`, undefined, 42]) {
    assert.equal(isValidMattermostId(invalidId), false, String(invalidId));
  }
});

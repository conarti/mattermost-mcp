import assert from 'node:assert/strict';
import type { AuthenticationLogger } from '../../src/authentication/runtime.js';

export interface LogCapture {
  readonly messages: string[];
  readonly logger: AuthenticationLogger;
  /** Число строк, содержащих фрагмент */
  count(fragment: string): number;
  includes(fragment: string): boolean;
}

export function createLogCapture(): LogCapture {
  const messages: string[] = [];
  return {
    messages,
    logger: (message) => {
      messages.push(message);
    },
    count: (fragment) => messages.filter((message) => message.includes(fragment)).length,
    includes: (fragment) => messages.some((message) => message.includes(fragment)),
  };
}

export function assertNoSecrets(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    for (const secret of secrets) {
      assert.equal(line.includes(secret), false, `log line contains a secret value: ${line.replace(secret, '<secret>')}`);
    }
  }
}

/** Фрагменты встречаются в строках лога в заданном порядке, между ними допускаются другие строки */
export function assertOrderedFragments(lines: readonly string[], fragments: readonly string[]): void {
  let lineIndex = 0;
  for (const fragment of fragments) {
    while (lineIndex < lines.length && !lines[lineIndex].includes(fragment)) {
      lineIndex += 1;
    }
    assert.ok(lineIndex < lines.length, `log fragment not found in order: ${fragment}\n${lines.join('\n')}`);
    lineIndex += 1;
  }
}

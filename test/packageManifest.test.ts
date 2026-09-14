import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PINNED_PLAYWRIGHT_VERSION } from '../src/authentication/constants.js';

const STATIC_PLAYWRIGHT_IMPORT_PATTERN = /from ['"]playwright['"]/;
const DYNAMIC_PLAYWRIGHT_IMPORT_PATTERN = /import\(['"]playwright['"]\)/;

test('V1: playwright is pinned to an exact version', async () => {
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.dependencies.playwright, PINNED_PLAYWRIGHT_VERSION);
  assert.match(packageJson.dependencies.playwright, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.scripts.postinstall, undefined);
});

test('V2: playwright is imported only dynamically and only from browserLogin', async () => {
  const compiledSourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
  const compiledFiles = (await readdir(compiledSourceDirectory, { recursive: true }))
    .filter((relativePath) => relativePath.endsWith('.js'))
    .sort();
  assert.ok(compiledFiles.length > 0);

  const filesWithDynamicImport: string[] = [];
  for (const relativePath of compiledFiles) {
    const content = await readFile(join(compiledSourceDirectory, relativePath), 'utf8');
    assert.equal(STATIC_PLAYWRIGHT_IMPORT_PATTERN.test(content), false, relativePath);
    if (DYNAMIC_PLAYWRIGHT_IMPORT_PATTERN.test(content)) {
      filesWithDynamicImport.push(relativePath);
    }
  }
  assert.deepEqual(filesWithDynamicImport, [join('authentication', 'browserLogin.js')]);
});

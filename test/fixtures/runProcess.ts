import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  standardOutput: Buffer;
  standardError: string;
}

/** Запуск дочернего процесса теста с трубами; вывод копится целиком, итог по событию close */
export function runProcess(
  command: string,
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve({
        code,
        signal,
        standardOutput: Buffer.concat(outputChunks),
        standardError: Buffer.concat(errorChunks).toString('utf8'),
      }),
    );
  });
}

export function environmentWithout(...variableNames: string[]): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variableName of variableNames) {
    delete environment[variableName];
  }
  return environment;
}

export async function removeDirectories(directories: readonly string[]): Promise<void> {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

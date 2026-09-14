import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  InstallationChildProcess,
  InstallationSpawnOptions,
  SpawnInstallationProcess,
} from '../../src/authentication/browserInstallation.js';

export interface FakeInstallationProcessOptions {
  /** Сигналы только записываются в журнал, процесс сам не завершается */
  ignoreSignals?: boolean;
  /** kill бросает исключение */
  throwOnKill?: boolean;
}

export interface EmitExitOptions {
  /** Без события close, как при потоке, который держит внук установщика */
  withoutClose?: boolean;
}

let nextFakeProcessId = 900_000;

/** Фейковый дочерний процесс установщика на PassThrough */
export class FakeInstallationChildProcess extends EventEmitter implements InstallationChildProcess {
  readonly pid: number | undefined = nextFakeProcessId++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  ignoreSignals: boolean;
  throwOnKill: boolean;
  private exitEmitted = false;

  constructor(options: FakeInstallationProcessOptions = {}) {
    super();
    this.ignoreSignals = options.ignoreSignals ?? false;
    this.throwOnKill = options.throwOnKill ?? false;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (this.throwOnKill) {
      throw new Error('fake kill failed');
    }
    if (!this.ignoreSignals && !this.exitEmitted) {
      this.emitExit(null, signal);
    }
    return true;
  }

  writeStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  writeStderr(chunk: string): void {
    this.stderr.write(chunk);
  }

  /** Потоки заканчиваются первыми, затем exit и close на следующих итерациях цикла, как у настоящего процесса */
  emitExit(code: number | null, signal: NodeJS.Signals | null, options: EmitExitOptions = {}): void {
    this.exitEmitted = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, signal);
      if (!options.withoutClose) {
        setImmediate(() => this.emit('close', code, signal));
      }
    });
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }
}

export interface FakeInstallationLaunch {
  command: string;
  commandArguments: readonly string[];
  options: InstallationSpawnOptions;
  child: FakeInstallationChildProcess;
}

export class FakeInstallationSpawner {
  readonly launches: FakeInstallationLaunch[] = [];
  private readonly launchWaiters: Array<(launch: FakeInstallationLaunch) => void> = [];

  constructor(
    private readonly processOptions: FakeInstallationProcessOptions = {},
    private readonly onLaunch?: (launch: FakeInstallationLaunch) => void,
  ) {}

  readonly spawn: SpawnInstallationProcess = (command, commandArguments, options) => {
    const launch: FakeInstallationLaunch = {
      command,
      commandArguments: [...commandArguments],
      options,
      child: new FakeInstallationChildProcess(this.processOptions),
    };
    this.launches.push(launch);
    this.onLaunch?.(launch);
    for (const waiter of this.launchWaiters.splice(0)) {
      waiter(launch);
    }
    return launch.child;
  };

  waitForLaunch(): Promise<FakeInstallationLaunch> {
    const existingLaunch = this.launches[0];
    if (existingLaunch !== undefined) {
      return Promise.resolve(existingLaunch);
    }
    return new Promise((resolve) => this.launchWaiters.push(resolve));
  }
}

/** never[] принимает обработчик с любыми параметрами, как у перегрузок process.on */
type ProcessEventListener = (...listenerArguments: never[]) => void;

/** Внедряемые события процесса: обработчики exit регистрируются здесь, а не на настоящем process */
export class FakeProcessEvents {
  private readonly listeners = new Map<string | symbol, ProcessEventListener[]>();

  readonly on = (event: string | symbol, listener: ProcessEventListener): NodeJS.Process => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return process;
  };

  readonly removeListener = (event: string | symbol, listener: ProcessEventListener): NodeJS.Process => {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((registeredListener) => registeredListener !== listener),
    );
    return process;
  };

  listenersOf(event: string): ProcessEventListener[] {
    return [...(this.listeners.get(event) ?? [])];
  }
}

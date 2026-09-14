import type {
  BrowserInstallationState,
  LoginBrowserContext,
  LoginBrowserCookie,
  LoginBrowserLauncher,
  LoginBrowserPage,
} from '../../src/authentication/browserLogin.js';

/** Шаг сценария cookie: список cookie или чтение, которое никогда не завершается */
export type FakeCookieStep = LoginBrowserCookie[] | 'never-resolves';

export interface FakeLoginBrowserContextOptions {
  /** Сценарий по номеру чтения; последний шаг повторяется */
  cookieSteps?: FakeCookieStep[];
  gotoNeverResolves?: boolean;
  closeNeverResolves?: boolean;
  /** Часы для журнала времени чтений cookie */
  now?: () => number;
}

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export class FakeLoginBrowserPage implements LoginBrowserPage {
  readonly gotoCalls: Array<{ url: string; options: { waitUntil: 'domcontentloaded'; timeout: number } }> = [];

  constructor(private readonly gotoNeverResolves: boolean) {}

  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown> {
    this.gotoCalls.push({ url, options });
    return this.gotoNeverResolves ? neverResolves() : Promise.resolve(null);
  }
}

export class FakeLoginBrowserContext implements LoginBrowserContext {
  readonly cookieUrls: string[][] = [];
  readonly cookieReadTimes: number[] = [];
  closeCalls = 0;
  newPageCalls = 0;
  private openPages: FakeLoginBrowserPage[];
  /** Сценарий можно менять по ходу теста */
  readonly cookieSteps: FakeCookieStep[];
  private readonly closeListeners: Array<() => void> = [];

  constructor(private readonly options: FakeLoginBrowserContextOptions = {}) {
    this.cookieSteps = [...(options.cookieSteps ?? [[]])];
    this.openPages = [new FakeLoginBrowserPage(options.gotoNeverResolves ?? false)];
  }

  get cookieReadCount(): number {
    return this.cookieUrls.length;
  }

  get firstPage(): FakeLoginBrowserPage {
    return this.openPages[0];
  }

  pages(): LoginBrowserPage[] {
    return [...this.openPages];
  }

  async newPage(): Promise<LoginBrowserPage> {
    this.newPageCalls += 1;
    const page = new FakeLoginBrowserPage(this.options.gotoNeverResolves ?? false);
    this.openPages.push(page);
    return page;
  }

  cookies(urls: string[]): Promise<LoginBrowserCookie[]> {
    const readIndex = this.cookieUrls.length;
    this.cookieUrls.push([...urls]);
    this.cookieReadTimes.push(this.options.now?.() ?? 0);
    const step = this.cookieSteps[Math.min(readIndex, this.cookieSteps.length - 1)];
    return step === 'never-resolves' ? neverResolves() : Promise.resolve(step.map((cookie) => ({ ...cookie })));
  }

  on(event: 'close', listener: () => void): unknown {
    if (event === 'close') {
      this.closeListeners.push(listener);
    }
    return this;
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.options.closeNeverResolves ? neverResolves() : Promise.resolve();
  }

  /** Закрыто последнее окно, а процесс Chromium жив, как на macOS */
  closeLastWindow(): void {
    this.openPages = [];
  }

  /** Контекст закрыт или браузер вышел */
  emitClose(): void {
    this.openPages = [];
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

export class FakeLoginBrowserLauncher implements LoginBrowserLauncher {
  readonly launchCalls: string[] = [];
  inspectCalls = 0;
  private installed: boolean;
  private readonly executablePath: string;

  constructor(
    readonly context: FakeLoginBrowserContext = new FakeLoginBrowserContext(),
    options: { installed?: boolean; executablePath?: string } = {},
  ) {
    this.installed = options.installed ?? true;
    this.executablePath = options.executablePath ?? '/fake/browsers/chromium-1243/chrome';
  }

  /** Флаг выставляет фейковый установщик после успешной установки */
  markInstalled(): void {
    this.installed = true;
  }

  async inspectInstallation(): Promise<BrowserInstallationState> {
    this.inspectCalls += 1;
    return { kind: this.installed ? 'installed' : 'missing', executablePath: this.executablePath };
  }

  async launch(profileDirectory: string): Promise<LoginBrowserContext> {
    this.launchCalls.push(profileDirectory);
    return this.context;
  }
}

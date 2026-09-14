import type { RequestCallContext, TokenProvider } from '../../src/authentication/session.js';
import type { AuthenticationMode } from '../../src/config.js';

export const TOKEN_PROVIDER_CALL_KINDS = {
  GET_TOKEN: 'getToken',
  RECOVER_FROM_UNAUTHORIZED: 'recoverFromUnauthorized',
} as const;

export interface TokenProviderCall {
  readonly kind: typeof TOKEN_PROVIDER_CALL_KINDS[keyof typeof TOKEN_PROVIDER_CALL_KINDS];
  readonly callContext: RequestCallContext;
}

export type RecoverFromUnauthorized = (callContext: RequestCallContext) => Promise<string | undefined>;

/** Провайдер токена, который записывает контекст каждого вызова по порядку */
export class RecordingTokenProvider implements TokenProvider {
  readonly calls: TokenProviderCall[] = [];

  constructor(
    readonly mode: AuthenticationMode,
    private readonly token: string,
    private readonly recover: RecoverFromUnauthorized = async () => undefined,
  ) {}

  async getToken(callContext: RequestCallContext): Promise<string> {
    this.calls.push({ kind: TOKEN_PROVIDER_CALL_KINDS.GET_TOKEN, callContext });
    return this.token;
  }

  async recoverFromUnauthorized(_rejectedToken: string, callContext: RequestCallContext): Promise<string | undefined> {
    this.calls.push({ kind: TOKEN_PROVIDER_CALL_KINDS.RECOVER_FROM_UNAUTHORIZED, callContext });
    return this.recover(callContext);
  }
}

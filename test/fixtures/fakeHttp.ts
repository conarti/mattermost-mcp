import { AUTHORIZATION_HEADER_NAME, BEARER_TOKEN_PREFIX } from '../../src/authentication/constants.js';
import type { HttpFetch, HttpRequest, HttpResponse } from '../../src/types.js';

export interface FakeHttpRecord {
  readonly method: HttpRequest['method'];
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly redirect: HttpRequest['redirect'];
}

export interface FakeHttpReply {
  readonly status: number;
  readonly statusText?: string;
  /** Строка отдаётся из text() как есть, остальное сериализуется в JSON */
  readonly body?: unknown;
}

/** Ответ выбирается по токену из заголовка Authorization и по записи запроса */
export type FakeHttpScenario = (token: string | undefined, record: FakeHttpRecord) => FakeHttpReply;

const STATUS_TEXTS: Readonly<Record<number, string>> = {
  200: 'OK',
  401: 'Unauthorized',
  403: 'Forbidden',
  500: 'Internal Server Error',
};

function extractToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith(BEARER_TOKEN_PREFIX)) {
    return undefined;
  }
  return authorization.slice(BEARER_TOKEN_PREFIX.length);
}

function createResponse(reply: FakeHttpReply): HttpResponse {
  const bodyText = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    statusText: reply.statusText ?? STATUS_TEXTS[reply.status] ?? '',
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  };
}

export class FakeHttp {
  readonly records: FakeHttpRecord[] = [];
  readonly fetch: HttpFetch;

  constructor(private scenario: FakeHttpScenario) {
    this.fetch = async (url, request) => {
      const record: FakeHttpRecord = {
        method: request.method,
        url,
        authorization: request.headers[AUTHORIZATION_HEADER_NAME],
        body: request.body,
        signal: request.signal,
        redirect: request.redirect,
      };
      this.records.push(record);
      return createResponse(this.scenario(extractToken(record.authorization), record));
    };
  }

  setScenario(scenario: FakeHttpScenario): void {
    this.scenario = scenario;
  }
}

/** Сценарий по токену: известный токен получает свой ответ, остальные получают fallbackReply */
export function createTokenScenario(
  repliesByToken: Readonly<Record<string, FakeHttpReply>>,
  fallbackReply: FakeHttpReply,
): FakeHttpScenario {
  return (token) => (token !== undefined && Object.hasOwn(repliesByToken, token) ? repliesByToken[token] : fallbackReply);
}

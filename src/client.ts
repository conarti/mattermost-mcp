import fetch from 'node-fetch';
import { AuthenticationMode, Config, loadConfig } from './config.js';
import {
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_MODES,
  AUTHORIZATION_HEADER_NAME,
  BEARER_TOKEN_PREFIX,
  CONTENT_TYPE_HEADER_NAME,
  CURRENT_USER_API_PATH,
  HTTP_GET_METHOD,
  HTTP_POST_METHOD,
  HTTP_STATUS_UNAUTHORIZED,
  JSON_CONTENT_TYPE,
} from './authentication/constants.js';
import { MattermostAuthenticationError, createStderrAuthenticationLogger } from './authentication/runtime.js';
import {
  BACKGROUND_CALL_CONTEXT,
  RequestCallContext,
  TokenProvider,
  createTokenProvider,
} from './authentication/session.js';
import {
  Channel,
  Post,
  User,
  UserProfile,
  Reaction,
  PostsResponse,
  ChannelsResponse,
  UsersResponse,
  HttpFetch,
  HttpRequest,
  HttpResponse
} from './types.js';

const REQUEST_STILL_UNAUTHORIZED_MESSAGE = 'request still unauthorized after sign-in';
const UNAUTHORIZED_AFTER_SIGN_IN_STATUS_DESCRIPTION = `${HTTP_STATUS_UNAUTHORIZED} Unauthorized after sign-in`;
const REQUEST_CANCELLED_LOG_MESSAGE = 'caller cancelled, request not sent';
const REQUEST_CANCELLED_DESCRIPTION = 'request cancelled by caller';

const authenticationLogger = createStderrAuthenticationLogger();

const nodeFetchImplementation: HttpFetch = (url, request) =>
  fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
  });

export interface MattermostClientDependencies {
  config?: Config;
  tokenProvider?: TokenProvider;
  fetchImplementation?: HttpFetch;
  callContext?: RequestCallContext;
}

interface MattermostRequestOptions {
  method: HttpRequest['method'];
  url: string;
  body?: unknown;
  failureMessage: string;
  includeResponseBodyInError: boolean;
  /** Статус ответа и тело ошибки в stderr, как делал getChannels в 1.1.2 */
  logResponseDiagnostics?: boolean;
}

export class MattermostClient {
  private readonly config: Config;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImplementation: HttpFetch;
  private readonly callContext: RequestCallContext;
  private baseUrl: string;
  private teamId: string;

  constructor(dependencies: MattermostClientDependencies = {}) {
    this.config = dependencies.config ?? loadConfig();
    this.fetchImplementation = dependencies.fetchImplementation ?? nodeFetchImplementation;
    this.tokenProvider = dependencies.tokenProvider ?? createTokenProvider(this.config, this.fetchImplementation);
    this.callContext = dependencies.callContext ?? BACKGROUND_CALL_CONTEXT;
    this.baseUrl = this.config.mattermostUrl;
    this.teamId = this.config.teamId;
  }

  /** Представление клиента для одного вызова инструмента: общий провайдер токена, свой контекст */
  withCallContext(callContext: RequestCallContext): MattermostClient {
    return new MattermostClient({
      config: this.config,
      tokenProvider: this.tokenProvider,
      fetchImplementation: this.fetchImplementation,
      callContext,
    });
  }

  get authenticationMode(): AuthenticationMode {
    return this.tokenProvider.mode;
  }

  /** Отмена вызова учитывается только в браузерном режиме: статический режим, как в 1.1.2, от неё не зависит */
  private get cancellationSignal(): AbortSignal | undefined {
    return this.tokenProvider.mode === AUTHENTICATION_MODES.BROWSER ? this.callContext.cancellationSignal : undefined;
  }

  /** Ровно один повтор после 401: провайдер получает отвергнутый токен, в статическом режиме повтора нет */
  private async request<ResponseBody>(options: MattermostRequestOptions): Promise<ResponseBody> {
    const token = await this.tokenProvider.getToken(this.callContext);
    this.throwIfCallCancelled(options);
    let response = await this.send(options, token);

    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
      const recoveredToken = await this.tokenProvider.recoverFromUnauthorized(token, this.callContext);
      if (recoveredToken === undefined) {
        throw await this.createFailureError(options, response);
      }
      /* Непрочитанное тело отвергнутого ответа держит соединение до сборки мусора */
      await response.text().catch(() => undefined);
      this.throwIfCallCancelled(options);
      response = await this.send(options, recoveredToken);
      if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        authenticationLogger(REQUEST_STILL_UNAUTHORIZED_MESSAGE);
        throw new MattermostAuthenticationError(
          AUTHENTICATION_ERROR_CODES.UNAUTHORIZED_AFTER_RETRY,
          `${options.failureMessage}: ${UNAUTHORIZED_AFTER_SIGN_IN_STATUS_DESCRIPTION}`,
        );
      }
    }

    if (!response.ok) {
      throw await this.createFailureError(options, response);
    }

    return (await response.json()) as ResponseBody;
  }

  /** Вход, дождавшийся отмены вызова, сохраняет токен в сессии, но действие вызова уже не отправляется */
  private throwIfCallCancelled(options: MattermostRequestOptions): void {
    if (this.cancellationSignal?.aborted) {
      authenticationLogger(REQUEST_CANCELLED_LOG_MESSAGE);
      throw new MattermostAuthenticationError(
        AUTHENTICATION_ERROR_CODES.REQUEST_CANCELLED,
        `${options.failureMessage}: ${REQUEST_CANCELLED_DESCRIPTION}`,
      );
    }
  }

  private async send(options: MattermostRequestOptions, token: string): Promise<HttpResponse> {
    const response = await this.fetchImplementation(options.url, {
      method: options.method,
      headers: {
        [AUTHORIZATION_HEADER_NAME]: `${BEARER_TOKEN_PREFIX}${token}`,
        [CONTENT_TYPE_HEADER_NAME]: JSON_CONTENT_TYPE,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: this.cancellationSignal,
    });

    if (options.logResponseDiagnostics) {
      console.error(`Response status: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  private async createFailureError(options: MattermostRequestOptions, response: HttpResponse): Promise<Error> {
    const failureDescription = `${options.failureMessage}: ${response.status} ${response.statusText}`;
    if (!options.includeResponseBodyInError) {
      return new Error(failureDescription);
    }

    const errorText = await response.text();
    if (options.logResponseDiagnostics) {
      console.error(`Error response body: ${errorText}`);
    }
    return new Error(`${failureDescription} - ${errorText}`);
  }

  async getChannels(limit: number = 100, page: number = 0): Promise<ChannelsResponse> {
    const url = new URL(`${this.baseUrl}/teams/${this.teamId}/channels`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    console.error(`Fetching channels from URL: ${url.toString()}`);

    try {
      /* API возвращает массив каналов, а ChannelsResponse ожидает объект со списком */
      const channelsArray = await this.request<Channel[] | ChannelsResponse>({
        method: HTTP_GET_METHOD,
        url: url.toString(),
        failureMessage: 'Failed to get channels',
        includeResponseBodyInError: true,
        logResponseDiagnostics: true,
      });

      console.error(`Response data type: ${typeof channelsArray}, isArray: ${Array.isArray(channelsArray)}`);

      if (Array.isArray(channelsArray)) {
        return {
          channels: channelsArray,
          total_count: channelsArray.length
        };
      }

      return channelsArray;
    } catch (error) {
      console.error(`Error fetching channels: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getChannel(channelId: string): Promise<Channel> {
    return this.request<Channel>({
      method: HTTP_GET_METHOD,
      url: `${this.baseUrl}/channels/${channelId}`,
      failureMessage: 'Failed to get channel',
      includeResponseBodyInError: false,
    });
  }

  async createPost(channelId: string, message: string, rootId?: string): Promise<Post> {
    return this.request<Post>({
      method: HTTP_POST_METHOD,
      url: `${this.baseUrl}/posts`,
      body: {
        channel_id: channelId,
        message,
        root_id: rootId || ''
      },
      failureMessage: 'Failed to create post',
      includeResponseBodyInError: false,
    });
  }

  async getPostsForChannel(
    channelId: string,
    limit: number = 30,
    page: number = 0,
    options?: {
      /** Unix-время в миллисекундах */
      since?: number;
      before?: string;
      after?: string;
    }
  ): Promise<PostsResponse> {
    const url = new URL(`${this.baseUrl}/channels/${channelId}/posts`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    if (options?.since) {
      url.searchParams.append('since', options.since.toString());
    }
    if (options?.before) {
      url.searchParams.append('before', options.before);
    }
    if (options?.after) {
      url.searchParams.append('after', options.after);
    }

    return this.request<PostsResponse>({
      method: HTTP_GET_METHOD,
      url: url.toString(),
      failureMessage: 'Failed to get posts',
      includeResponseBodyInError: false,
    });
  }

  async getAllPostsForChannel(
    channelId: string,
    options?: {
      since?: number;
      before?: string;
      after?: string;
      /** По умолчанию без ограничения */
      maxPosts?: number;
    }
  ): Promise<PostsResponse> {
    const allPosts: Record<string, Post> = {};
    const allOrder: string[] = [];
    /* Максимум Mattermost API на одну страницу */
    const perPage = 200;
    let page = 0;
    let hasMore = true;
    const maxPosts = options?.maxPosts || Infinity;

    while (hasMore && allOrder.length < maxPosts) {
      const response = await this.getPostsForChannel(channelId, perPage, page, {
        since: options?.since,
        before: options?.before,
        after: options?.after,
      });

      if (response.order.length === 0) {
        hasMore = false;
        break;
      }

      Object.assign(allPosts, response.posts);
      allOrder.push(...response.order);

      hasMore = response.order.length === perPage;
      page++;

      if (allOrder.length >= maxPosts) {
        break;
      }
    }

    return {
      order: allOrder.slice(0, maxPosts),
      posts: allPosts,
      next_post_id: '',
      prev_post_id: '',
    };
  }

  async getPost(postId: string): Promise<Post> {
    return this.request<Post>({
      method: HTTP_GET_METHOD,
      url: `${this.baseUrl}/posts/${postId}`,
      failureMessage: 'Failed to get post',
      includeResponseBodyInError: false,
    });
  }

  async getPostThread(postId: string): Promise<PostsResponse> {
    return this.request<PostsResponse>({
      method: HTTP_GET_METHOD,
      url: `${this.baseUrl}/posts/${postId}/thread`,
      failureMessage: 'Failed to get post thread',
      includeResponseBodyInError: false,
    });
  }

  async addReaction(postId: string, emojiName: string): Promise<Reaction> {
    return this.request<Reaction>({
      method: HTTP_POST_METHOD,
      url: `${this.baseUrl}/reactions`,
      body: {
        post_id: postId,
        emoji_name: emojiName
      },
      failureMessage: 'Failed to add reaction',
      includeResponseBodyInError: false,
    });
  }

  async getUsers(limit: number = 100, page: number = 0): Promise<UsersResponse> {
    const url = new URL(`${this.baseUrl}/users`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    const usersArray = await this.request<User[] | UsersResponse>({
      method: HTTP_GET_METHOD,
      url: url.toString(),
      failureMessage: 'Failed to get users',
      includeResponseBodyInError: false,
    });

    if (Array.isArray(usersArray)) {
      return {
        users: usersArray,
        total_count: usersArray.length
      };
    }

    return usersArray;
  }

  async getUserProfile(userId: string): Promise<UserProfile> {
    return this.request<UserProfile>({
      method: HTTP_GET_METHOD,
      url: `${this.baseUrl}/users/${userId}`,
      failureMessage: 'Failed to get user profile',
      includeResponseBodyInError: false,
    });
  }

  async getMe(): Promise<UserProfile> {
    return this.request<UserProfile>({
      method: HTTP_GET_METHOD,
      url: `${this.baseUrl}${CURRENT_USER_API_PATH}`,
      failureMessage: 'Failed to get current user',
      includeResponseBodyInError: false,
    });
  }

  /** Включает приватные каналы и личные сообщения */
  async getMyChannels(limit: number = 100, page: number = 0): Promise<ChannelsResponse> {
    const url = new URL(`${this.baseUrl}${CURRENT_USER_API_PATH}/channels`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    try {
      const channelsArray = await this.request<Channel[] | ChannelsResponse>({
        method: HTTP_GET_METHOD,
        url: url.toString(),
        failureMessage: 'Failed to get user channels',
        includeResponseBodyInError: true,
      });

      if (Array.isArray(channelsArray)) {
        return {
          channels: channelsArray,
          total_count: channelsArray.length
        };
      }

      return channelsArray;
    } catch (error) {
      console.error(`Error fetching user channels: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async createDirectMessageChannel(otherUserId: string): Promise<Channel> {
    const me = await this.getMe();

    return this.request<Channel>({
      method: HTTP_POST_METHOD,
      url: `${this.baseUrl}/channels/direct`,
      body: [me.id, otherUserId],
      failureMessage: 'Failed to create direct message channel',
      includeResponseBodyInError: true,
    });
  }
}

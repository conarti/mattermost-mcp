import fetch from 'node-fetch';
import { loadConfig } from './config.js';
import {
  Channel,
  Post,
  User,
  UserProfile,
  Reaction,
  PostsResponse,
  ChannelsResponse,
  UsersResponse
} from './types.js';

export class MattermostClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private teamId: string;

  constructor() {
    const config = loadConfig();
    this.baseUrl = config.mattermostUrl;
    this.teamId = config.teamId;
    this.headers = {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    };
  }

  // Channel-related methods
  async getChannels(limit: number = 100, page: number = 0): Promise<ChannelsResponse> {
    const url = new URL(`${this.baseUrl}/teams/${this.teamId}/channels`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());
    
    console.error(`Fetching channels from URL: ${url.toString()}`);
    console.error(`Using headers: ${JSON.stringify(this.headers)}`);
    
    try {
      const response = await fetch(url.toString(), { headers: this.headers });
      
      console.error(`Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error response body: ${errorText}`);
        throw new Error(`Failed to get channels: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      // The API returns an array of channels, but our ChannelsResponse type expects an object
      // with a channels property, so we need to transform the response
      const channelsArray = await response.json();
      
      console.error(`Response data type: ${typeof channelsArray}, isArray: ${Array.isArray(channelsArray)}`);
      
      // Check if the response is an array (as expected from the API)
      if (Array.isArray(channelsArray)) {
        return {
          channels: channelsArray,
          total_count: channelsArray.length
        };
      }
      
      // If it's already in the expected format, return it as is
      return channelsArray as ChannelsResponse;
    } catch (error) {
      console.error(`Error fetching channels: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getChannel(channelId: string): Promise<Channel> {
    const url = `${this.baseUrl}/channels/${channelId}`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Failed to get channel: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<Channel>;
  }

  // Post-related methods
  async createPost(channelId: string, message: string, rootId?: string): Promise<Post> {
    const url = `${this.baseUrl}/posts`;
    const body = {
      channel_id: channelId,
      message,
      root_id: rootId || ''
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create post: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<Post>;
  }

  async getPostsForChannel(
    channelId: string,
    limit: number = 30,
    page: number = 0,
    options?: {
      since?: number;      // Unix timestamp in milliseconds
      before?: string;     // Post ID to get posts before
      after?: string;      // Post ID to get posts after
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

    const response = await fetch(url.toString(), { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to get posts: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<PostsResponse>;
  }

  // Get all posts from a channel with auto-pagination
  async getAllPostsForChannel(
    channelId: string,
    options?: {
      since?: number;
      before?: string;
      after?: string;
      maxPosts?: number;   // Maximum number of posts to fetch (default: no limit)
    }
  ): Promise<PostsResponse> {
    const allPosts: Record<string, Post> = {};
    const allOrder: string[] = [];
    const perPage = 200; // Max per page
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

      // Merge posts
      Object.assign(allPosts, response.posts);
      allOrder.push(...response.order);

      // Check if there are more posts
      hasMore = response.order.length === perPage;
      page++;

      // Respect maxPosts limit
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
    const url = `${this.baseUrl}/posts/${postId}`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Failed to get post: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<Post>;
  }

  async getPostThread(postId: string): Promise<PostsResponse> {
    const url = `${this.baseUrl}/posts/${postId}/thread`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Failed to get post thread: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<PostsResponse>;
  }

  // Reaction-related methods
  async addReaction(postId: string, emojiName: string): Promise<Reaction> {
    const url = `${this.baseUrl}/reactions`;
    const body = {
      post_id: postId,
      emoji_name: emojiName
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to add reaction: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<Reaction>;
  }

  // User-related methods
  async getUsers(limit: number = 100, page: number = 0): Promise<UsersResponse> {
    const url = new URL(`${this.baseUrl}/users`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    const response = await fetch(url.toString(), { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to get users: ${response.status} ${response.statusText}`);
    }

    // The API returns an array of users directly
    const usersArray = await response.json();

    if (Array.isArray(usersArray)) {
      return {
        users: usersArray,
        total_count: usersArray.length
      };
    }

    return usersArray as UsersResponse;
  }

  async getUserProfile(userId: string): Promise<UserProfile> {
    const url = `${this.baseUrl}/users/${userId}`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Failed to get user profile: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<UserProfile>;
  }
  
  // Get current authenticated user
  async getMe(): Promise<UserProfile> {
    const url = `${this.baseUrl}/users/me`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`Failed to get current user: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<UserProfile>;
  }

  // Get channels for current user (includes private channels and DMs)
  async getMyChannels(limit: number = 100, page: number = 0): Promise<ChannelsResponse> {
    const url = new URL(`${this.baseUrl}/users/me/channels`);
    url.searchParams.append('page', page.toString());
    url.searchParams.append('per_page', limit.toString());

    try {
      const response = await fetch(url.toString(), { headers: this.headers });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get user channels: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const channelsArray = await response.json();

      if (Array.isArray(channelsArray)) {
        return {
          channels: channelsArray,
          total_count: channelsArray.length
        };
      }

      return channelsArray as ChannelsResponse;
    } catch (error) {
      console.error(`Error fetching user channels: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  // Direct message channel methods
  async createDirectMessageChannel(otherUserId: string): Promise<Channel> {
    // First get current user ID
    const me = await this.getMe();

    const url = `${this.baseUrl}/channels/direct`;
    const body = [me.id, otherUserId];

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create direct message channel: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<Channel>;
  }
}

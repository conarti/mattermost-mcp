import { MattermostClient } from '../client.js';
import { MonitoringConfig } from '../config.js';
import { MattermostAuthenticationError, createStderrAuthenticationLogger } from '../authentication/runtime.js';
import { BACKGROUND_CALL_CONTEXT } from '../authentication/session.js';
import { Channel, Post, User, UserProfile } from '../types.js';
import { findRelevantPosts, createNotificationMessage } from './analyzer.js';
import { Scheduler } from './scheduler.js';

export const MONITORING_RUN_SKIPPED_MESSAGE = 'monitoring run skipped';

const authenticationLogger = createStderrAuthenticationLogger();

/**
 * TopicMonitor class for monitoring channels for topics of interest
 */
export class TopicMonitor {
  private client: MattermostClient;
  private config: MonitoringConfig;
  private scheduler: Scheduler;
  private channelCache: Map<string, string> = new Map(); // Map of channel names to IDs
  private currentUserId: string | null = null;
  private currentUsername: string | null = null;
  private directMessageChannelId: string | null = null;

  /**
   * Creates a new topic monitor
   * @param client Mattermost client
   * @param config Monitoring configuration
   */
  constructor(client: MattermostClient, config: MonitoringConfig) {
    /* Запуски по расписанию и runNow идут вне вызова инструмента и не должны открывать окно входа */
    this.client = client.withCallContext(BACKGROUND_CALL_CONTEXT);
    this.config = config;
    this.scheduler = new Scheduler(config, this.monitorChannels.bind(this));
  }

  /**
   * Initializes the monitor by fetching necessary user information
   */
  async initialize(): Promise<void> {
    // If userId is not provided, fetch the current user's information
    if (!this.config.userId) {
      await this.fetchCurrentUser();
    } else {
      this.currentUserId = this.config.userId;
    }

    // If notificationChannelId is not provided, create or find a direct message channel
    if (!this.config.notificationChannelId) {
      await this.createDirectMessageChannel();
    }
  }

  /**
   * Fetches the current user's information
   */
  private async fetchCurrentUser(): Promise<void> {
    try {
      // Try to get the user ID from the response
      try {
        // Get the first page of users
        const response = await this.client.getUsers(100, 0);
        
        // If response is an array (not the expected UsersResponse format)
        if (Array.isArray(response)) {
          // Find a non-bot user (preferably sysadmin)
          for (const user of response) {
            if (user.username === 'sysadmin') {
              this.currentUserId = user.id;
              this.currentUsername = user.username;
              console.error(`Found sysadmin user: ${user.username} (${user.id})`);
              return;
            }
          }
          
          // If sysadmin not found, use any non-bot user
          for (const user of response) {
            if (!user.is_bot) {
              this.currentUserId = user.id;
              this.currentUsername = user.username;
              console.error(`Found user: ${user.username} (${user.id})`);
              return;
            }
          }
          
          // If no non-bot user found, use any user
          if (response.length > 0) {
            this.currentUserId = response[0].id;
            this.currentUsername = response[0].username;
            console.error(`Using first available user: ${response[0].username} (${response[0].id})`);
            return;
          }
        } else if (response && response.users && Array.isArray(response.users)) {
          // Standard format
          for (const user of response.users) {
            if (user.username === 'sysadmin') {
              this.currentUserId = user.id;
              this.currentUsername = user.username;
              console.error(`Found sysadmin user: ${user.username} (${user.id})`);
              return;
            }
          }
          
          for (const user of response.users) {
            if (!user.is_bot) {
              this.currentUserId = user.id;
              this.currentUsername = user.username;
              console.error(`Found user: ${user.username} (${user.id})`);
              return;
            }
          }
        } else {
          console.error('Response format unexpected:', response);
        }
      } catch (innerError) {
        if (innerError instanceof MattermostAuthenticationError) {
          throw innerError;
        }
        console.error('Error getting users:', innerError);
      }
      
      // Fallback: Use the town-square channel's first post author
      try {
        // Get the town-square channel
        const channelsResponse = await this.client.getChannels(100, 0);
        let townSquareId = null;
        
        if (channelsResponse && channelsResponse.channels && Array.isArray(channelsResponse.channels)) {
          for (const channel of channelsResponse.channels) {
            if (channel.name === 'town-square') {
              townSquareId = channel.id;
              break;
            }
          }
        }
        
        if (townSquareId) {
          // Get posts from town-square
          const postsResponse = await this.client.getPostsForChannel(townSquareId, 1, 0);
          
          if (postsResponse && postsResponse.posts) {
            // Get the first post's user ID
            const posts = Object.values(postsResponse.posts);
            if (posts.length > 0) {
              this.currentUserId = posts[0].user_id;
              
              // Get the username for this user ID
              try {
                const userProfile = await this.client.getUserProfile(this.currentUserId);
                this.currentUsername = userProfile.username;
                console.error(`Found username for post author: ${this.currentUsername}`);
              } catch (profileError) {
                if (profileError instanceof MattermostAuthenticationError) {
                  throw profileError;
                }
                console.error('Error getting user profile:', profileError);
                this.currentUsername = 'user';
              }
              
              console.error(`Using fallback user ID from post: ${this.currentUserId}`);
              return;
            }
          }
        }
      } catch (innerError) {
        if (innerError instanceof MattermostAuthenticationError) {
          throw innerError;
        }
        console.error('Error using fallback method:', innerError);
      }
      
      // Final fallback: Use hardcoded values
      this.currentUserId = "system";
      this.currentUsername = "system";
      console.error(`Using hardcoded user ID: ${this.currentUserId}`);
      
    } catch (error) {
      console.error('Error fetching current user:', error);
      throw error;
    }
  }

  /**
   * Creates or finds a direct message channel for the current user
   */
  private async createDirectMessageChannel(): Promise<void> {
    try {
      if (!this.currentUserId) {
        throw new Error('Current user ID is not set');
      }

      // Try to create a direct message channel with the user
      try {
        // First, try to find an existing DM channel
        const response = await this.client.getChannels(100, 0);
        
        if (response && response.channels && Array.isArray(response.channels)) {
          // Look for a direct message channel
          for (const channel of response.channels) {
            // Direct message channels have type 'D'
            if (channel.type === 'D') {
              this.directMessageChannelId = channel.id;
              console.error(`Found direct message channel: ${channel.id}`);
              return;
            }
          }
        }
        
        // If we couldn't find a DM channel, try to create one
        console.error('Could not find a direct message channel, attempting to create one...');
        
        try {
          // Create a direct message channel with the current user
          const dmChannel = await this.client.createDirectMessageChannel(this.currentUserId);
          this.directMessageChannelId = dmChannel.id;
          console.error(`Created direct message channel: ${dmChannel.id}`);
          return;
        } catch (createError) {
          if (createError instanceof MattermostAuthenticationError) {
            throw createError;
          }
          console.error('Error creating direct message channel:', createError);
        }
        
        // If creating a DM channel fails, use town-square as a fallback
        for (const channel of response.channels) {
          if (channel.name === 'town-square') {
            this.directMessageChannelId = channel.id;
            console.error(`Using town-square as fallback notification channel: ${channel.id}`);
            return;
          }
        }
      } catch (innerError) {
        if (innerError instanceof MattermostAuthenticationError) {
          throw innerError;
        }
        console.error('Error finding/creating DM channel:', innerError);
      }

      throw new Error('Could not find a suitable notification channel');
    } catch (error) {
      console.error('Error creating direct message channel:', error);
      throw error;
    }
  }

  /**
   * Starts the monitoring process
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.error('Monitoring is disabled in configuration');
      return;
    }

    // Initialize user information and notification channel
    await this.initialize();
    
    this.scheduler.start();
  }

  /**
   * Stops the monitoring process
   */
  stop(): void {
    this.scheduler.stop();
  }

  /**
   * Updates the monitoring configuration
   * @param config New monitoring configuration
   */
  updateConfig(config: MonitoringConfig): void {
    this.config = config;
    this.scheduler.updateConfig(config);
  }

  /**
   * Checks if the monitor is running
   * @returns True if the monitor is running, false otherwise
   */
  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  /**
   * Runs the monitoring process immediately
   */
  async runNow(): Promise<void> {
    console.error("Running monitoring process immediately...");
    await this.monitorChannels();
    console.error("Immediate monitoring process completed.");
  }

  /**
   * Main monitoring function that checks channels for topics of interest
   */
  private async monitorChannels(): Promise<void> {
    try {
      // Get channel IDs for the channels we want to monitor
      await this.refreshChannelCache();

      // Process each channel
      for (const channelName of this.config.channels) {
        await this.processChannel(channelName);
      }
    } catch (error) {
      if (error instanceof MattermostAuthenticationError) {
        authenticationLogger(`${MONITORING_RUN_SKIPPED_MESSAGE}: ${error.code}`);
        throw error;
      }
      console.error('Error in monitorChannels:', error);
    }
  }

  /**
   * Refreshes the cache of channel names to IDs
   */
  private async refreshChannelCache(): Promise<void> {
    try {
      // Get all channels
      const response = await this.client.getChannels(100, 0);
      
      // Update the cache
      for (const channel of response.channels) {
        this.channelCache.set(channel.name, channel.id);
      }
    } catch (error) {
      console.error('Error refreshing channel cache:', error);
      throw error;
    }
  }

  /**
   * Processes a single channel for topics of interest
   * @param channelName Name of the channel to process
   */
  private async processChannel(channelName: string): Promise<void> {
    try {
      // Get the channel ID
      const channelId = this.channelCache.get(channelName);
      if (!channelId) {
        console.error(`Channel not found: ${channelName}`);
        return;
      }

      // Get recent posts
      const postsResponse = await this.client.getPostsForChannel(
        channelId,
        this.config.messageLimit,
        0
      );

      // Convert posts object to array
      const posts: Post[] = Object.values(postsResponse.posts || {});
      
      if (posts.length === 0) {
        console.error(`No posts found in channel: ${channelName}`);
        return;
      }

      // Find posts that match the topics
      const relevantPosts = findRelevantPosts(posts, this.config.topics);
      
      if (relevantPosts.length === 0) {
        console.error(`No relevant posts found in channel: ${channelName}`);
        return;
      }

      console.error(`Found ${relevantPosts.length} relevant posts in channel: ${channelName}`);

      // Create and send notification
      const userId = this.config.userId || this.currentUserId;
      const username = this.currentUsername || 'user';
      if (!userId) {
        console.error('No user ID available for notification');
        return;
      }
      
      const notificationMessage = createNotificationMessage(
        relevantPosts,
        channelName,
        username  // Use username instead of userId
      );

      if (notificationMessage) {
        const channelId = this.config.notificationChannelId || this.directMessageChannelId;
        if (!channelId) {
          console.error('No notification channel ID available');
          return;
        }
        
        await this.client.createPost(
          channelId,
          notificationMessage
        );
        console.error(`Sent notification for channel: ${channelName}`);
      }
    } catch (error) {
      if (error instanceof MattermostAuthenticationError) {
        throw error;
      }
      console.error(`Error processing channel ${channelName}:`, error);
    }
  }
}

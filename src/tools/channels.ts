import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MattermostClient } from "../client.js";
import { ListChannelsArgs, GetChannelHistoryArgs } from "../types.js";

// Tool definition for listing channels
export const listChannelsTool: Tool = {
  name: "mattermost_list_channels",
  description: "List public channels in the Mattermost workspace with pagination",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of channels to return (default 100, max 200)",
        default: 100,
      },
      page: {
        type: "number",
        description: "Page number for pagination (starting from 0)",
        default: 0,
      },
    },
  },
};

// Tool definition for getting channel history
export const getChannelHistoryTool: Tool = {
  name: "mattermost_get_channel_history",
  description: "Get recent messages from a Mattermost channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel",
      },
      limit: {
        type: "number",
        description: "Number of messages to retrieve (default 30). Use 0 or 'all' to get all messages.",
        default: 30,
      },
      page: {
        type: "number",
        description: "Page number for pagination (starting from 0)",
        default: 0,
      },
      since_date: {
        type: "string",
        description: "Get messages after this date (ISO 8601 format, e.g., '2025-12-18' or '2025-12-18T10:00:00Z')",
      },
      before_post_id: {
        type: "string",
        description: "Get messages before this post ID",
      },
      after_post_id: {
        type: "string",
        description: "Get messages after this post ID",
      },
      get_all: {
        type: "boolean",
        description: "Get all messages from the channel (ignores limit/page, uses auto-pagination)",
        default: false,
      },
    },
    required: ["channel_id"],
  },
};

// Tool handler for listing channels
export async function handleListChannels(
  client: MattermostClient,
  args: ListChannelsArgs
) {
  const limit = args.limit || 100;
  const page = args.page || 0;
  
  try {
    const response = await client.getChannels(limit, page);
    
    // Check if response.channels exists
    if (!response || !response.channels) {
      console.error("API response missing channels array:", response);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "API response missing channels array",
              raw_response: response
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    
    // Format the response for better readability
    const formattedChannels = response.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      display_name: channel.display_name,
      type: channel.type,
      purpose: channel.purpose,
      header: channel.header,
      total_msg_count: channel.total_msg_count,
    }));
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            channels: formattedChannels,
            total_count: response.total_count || 0,
            page: page,
            per_page: limit,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error listing channels:", error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}

// Tool handler for getting channel history
export async function handleGetChannelHistory(
  client: MattermostClient,
  args: GetChannelHistoryArgs
) {
  const {
    channel_id,
    limit = 30,
    page = 0,
    since_date,
    before_post_id,
    after_post_id,
    get_all = false,
  } = args;

  try {
    // Parse since_date to timestamp if provided
    let sinceTimestamp: number | undefined;
    if (since_date) {
      const date = new Date(since_date);
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid date format: ${since_date}. Use ISO 8601 format (e.g., '2025-12-18' or '2025-12-18T10:00:00Z')`);
      }
      sinceTimestamp = date.getTime();
    }

    let response;

    if (get_all) {
      // Use auto-pagination to get all posts
      response = await client.getAllPostsForChannel(channel_id, {
        since: sinceTimestamp,
        before: before_post_id,
        after: after_post_id,
      });
    } else {
      response = await client.getPostsForChannel(channel_id, limit, page, {
        since: sinceTimestamp,
        before: before_post_id,
        after: after_post_id,
      });
    }

    // Format the posts for better readability
    const formattedPosts = response.order.map(postId => {
      const post = response.posts[postId];
      return {
        id: post.id,
        user_id: post.user_id,
        message: post.message,
        create_at: new Date(post.create_at).toISOString(),
        reply_count: post.reply_count,
        root_id: post.root_id || null,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            posts: formattedPosts,
            total_posts: formattedPosts.length,
            has_next: !get_all && !!response.next_post_id,
            has_prev: !get_all && !!response.prev_post_id,
            page: get_all ? null : page,
            per_page: get_all ? null : limit,
            filters: {
              since_date: since_date || null,
              before_post_id: before_post_id || null,
              after_post_id: after_post_id || null,
              get_all,
            },
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting channel history:", error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}

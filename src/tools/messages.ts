import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MattermostClient, MattermostRequestError } from "../client.js";
import { 
  PostMessageArgs, 
  ReplyToThreadArgs, 
  AddReactionArgs, 
  GetThreadRepliesArgs,
  GetPostArgs,
  EditPostArgs
} from "../types.js";
import { isValidMattermostId } from "./mattermostId.js";
import { formatPostAttachments } from "./postFormatting.js";

export const INVALID_POST_ID_MESSAGE = "Invalid post_id: expected a 26-character Mattermost id";
export const EDIT_POST_FORBIDDEN_HINT =
  "Only the post author or a user with permission to edit others' posts can edit this post.";

const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

export function createPostNotFoundMessage(postId: string): string {
  return `Post ${postId} not found or not accessible`;
}

// Tool definition for posting a message
export const postMessageTool: Tool = {
  name: "mattermost_post_message",
  description: "Post a new message to a Mattermost channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel to post to",
      },
      message: {
        type: "string",
        description: "The message text to post",
      },
    },
    required: ["channel_id", "message"],
  },
};

// Tool definition for replying to a thread
export const replyToThreadTool: Tool = {
  name: "mattermost_reply_to_thread",
  description: "Reply to a specific message thread in Mattermost",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      post_id: {
        type: "string",
        description: "The ID of the parent message to reply to",
      },
      message: {
        type: "string",
        description: "The reply text",
      },
    },
    required: ["channel_id", "post_id", "message"],
  },
};

// Tool definition for adding a reaction
export const addReactionTool: Tool = {
  name: "mattermost_add_reaction",
  description: "Add a reaction emoji to a message",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the message",
      },
      post_id: {
        type: "string",
        description: "The ID of the message to react to",
      },
      emoji_name: {
        type: "string",
        description: "The name of the emoji reaction (without colons)",
      },
    },
    required: ["channel_id", "post_id", "emoji_name"],
  },
};

// Tool definition for getting thread replies
export const getThreadRepliesTool: Tool = {
  name: "mattermost_get_thread_replies",
  description: "Get all replies in a message thread",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      post_id: {
        type: "string",
        description: "The ID of the parent message",
      },
    },
    required: ["channel_id", "post_id"],
  },
};

// Tool handler for posting a message
export async function handlePostMessage(
  client: MattermostClient,
  args: PostMessageArgs
) {
  const { channel_id, message } = args;
  
  try {
    const response = await client.createPost(channel_id, message);
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: response.id,
            channel_id: response.channel_id,
            message: response.message,
            create_at: new Date(response.create_at).toISOString(),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error posting message:", error);
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

// Tool handler for replying to a thread
export async function handleReplyToThread(
  client: MattermostClient,
  args: ReplyToThreadArgs
) {
  const { channel_id, post_id, message } = args;
  
  try {
    const response = await client.createPost(channel_id, message, post_id);
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: response.id,
            channel_id: response.channel_id,
            root_id: response.root_id,
            message: response.message,
            create_at: new Date(response.create_at).toISOString(),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error replying to thread:", error);
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

// Tool handler for adding a reaction
export async function handleAddReaction(
  client: MattermostClient,
  args: AddReactionArgs
) {
  const { post_id, emoji_name } = args;
  
  try {
    const response = await client.addReaction(post_id, emoji_name);
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            post_id: response.post_id,
            user_id: response.user_id,
            emoji_name: response.emoji_name,
            create_at: new Date(response.create_at).toISOString(),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error adding reaction:", error);
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

// Tool handler for getting thread replies
export async function handleGetThreadReplies(
  client: MattermostClient,
  args: GetThreadRepliesArgs
) {
  const { post_id } = args;
  
  try {
    const response = await client.getPostThread(post_id);
    
    // Format the posts for better readability
    const formattedPosts = response.order.map(postId => {
      const post = response.posts[postId];
      return {
        id: post.id,
        user_id: post.user_id,
        message: post.message,
        create_at: new Date(post.create_at).toISOString(),
        root_id: post.root_id || null,
        ...formatPostAttachments(post),
      };
    });
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            posts: formattedPosts,
            root_post: response.posts[post_id] ? {
              id: response.posts[post_id].id,
              user_id: response.posts[post_id].user_id,
              message: response.posts[post_id].message,
              create_at: new Date(response.posts[post_id].create_at).toISOString(),
              ...formatPostAttachments(response.posts[post_id]),
            } : null,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting thread replies:", error);
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

export const getPostTool: Tool = {
  name: "mattermost_get_post",
  description: "Get a single message by its ID, including edit time and attachments",
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "The ID of the message",
      },
    },
    required: ["post_id"],
  },
};

export const editPostTool: Tool = {
  name: "mattermost_edit_post",
  description:
    "Edit the text of an existing message. " +
    'Mattermost marks an edited post as "Edited" for everyone in the channel. ' +
    "Only the post author or a user with permission to edit others' posts can edit it.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "The ID of the message to edit",
      },
      message: {
        type: "string",
        description: "The new message text that replaces the current one",
      },
    },
    required: ["post_id", "message"],
  },
};

function createErrorResult(message: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: message,
        }),
      },
    ],
    isError: true,
  };
}

function formatOptionalTimestamp(timestamp: number): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

function describeGetPostError(error: unknown, postId: string): string {
  if (error instanceof MattermostRequestError && error.status === HTTP_STATUS_NOT_FOUND) {
    return createPostNotFoundMessage(postId);
  }
  return error instanceof Error ? error.message : String(error);
}

function describeEditPostError(error: unknown): string {
  if (error instanceof MattermostRequestError && error.status === HTTP_STATUS_FORBIDDEN) {
    return `${error.message} ${EDIT_POST_FORBIDDEN_HINT}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function handleGetPost(
  client: MattermostClient,
  args: GetPostArgs
) {
  const { post_id } = args;
  if (!isValidMattermostId(post_id)) {
    return createErrorResult(INVALID_POST_ID_MESSAGE);
  }

  try {
    const post = await client.getPost(post_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: post.id,
            channel_id: post.channel_id,
            user_id: post.user_id,
            message: post.message,
            create_at: new Date(post.create_at).toISOString(),
            edit_at: formatOptionalTimestamp(post.edit_at),
            root_id: post.root_id || null,
            ...formatPostAttachments(post),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting post:", error);
    return createErrorResult(describeGetPostError(error, post_id));
  }
}

export async function handleEditPost(
  client: MattermostClient,
  args: EditPostArgs
) {
  const { post_id, message } = args;
  if (!isValidMattermostId(post_id)) {
    return createErrorResult(INVALID_POST_ID_MESSAGE);
  }

  try {
    const post = await client.patchPost(post_id, message);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: post.id,
            message: post.message,
            edit_at: formatOptionalTimestamp(post.edit_at),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error editing post:", error);
    return createErrorResult(describeEditPostError(error));
  }
}

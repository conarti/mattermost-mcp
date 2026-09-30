import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { 
  listChannelsTool, 
  getChannelHistoryTool,
  handleListChannels,
  handleGetChannelHistory
} from "./channels.js";
import { 
  postMessageTool, 
  replyToThreadTool, 
  addReactionTool, 
  getThreadRepliesTool,
  getPostTool,
  editPostTool,
  handlePostMessage,
  handleReplyToThread,
  handleAddReaction,
  handleGetThreadReplies,
  handleGetPost,
  handleEditPost
} from "./messages.js";
import {
  getFileInfoTool,
  downloadFileTool,
  handleGetFileInfo,
  handleDownloadFile
} from "./files.js";
import { 
  getUsersTool, 
  getUserProfileTool,
  handleGetUsers,
  handleGetUserProfile
} from "./users.js";
import {
  runMonitoringTool,
  handleRunMonitoring,
  setTopicMonitorInstance
} from "./monitoring.js";
import { MattermostClient } from "../client.js";
import { BACKGROUND_CALL_CONTEXT, RequestCallContext } from "../authentication/session.js";

// Export all tool definitions
export const tools: Tool[] = [
  listChannelsTool,
  getChannelHistoryTool,
  postMessageTool,
  replyToThreadTool,
  addReactionTool,
  getThreadRepliesTool,
  getPostTool,
  editPostTool,
  getFileInfoTool,
  downloadFileTool,
  getUsersTool,
  getUserProfileTool,
  runMonitoringTool
];

// Export the setTopicMonitorInstance function
export { setTopicMonitorInstance };

// Tool handler map
export const toolHandlers: Record<string, Function> = {
  mattermost_list_channels: handleListChannels,
  mattermost_get_channel_history: handleGetChannelHistory,
  mattermost_post_message: handlePostMessage,
  mattermost_reply_to_thread: handleReplyToThread,
  mattermost_add_reaction: handleAddReaction,
  mattermost_get_thread_replies: handleGetThreadReplies,
  mattermost_get_post: handleGetPost,
  mattermost_edit_post: handleEditPost,
  mattermost_get_file_info: handleGetFileInfo,
  mattermost_download_file: handleDownloadFile,
  mattermost_get_users: handleGetUsers,
  mattermost_get_user_profile: handleGetUserProfile,
  mattermost_run_monitoring: handleRunMonitoring
};

// Execute a tool with the given name and arguments
export async function executeTool(
  client: MattermostClient,
  toolName: string,
  args: any,
  callContext: RequestCallContext = BACKGROUND_CALL_CONTEXT
) {
  const handler = toolHandlers[toolName];
  
  if (!handler) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Unknown tool: ${toolName}`,
          }),
        },
      ],
      isError: true,
    };
  }
  
  try {
    return await handler(client.withCallContext(callContext), args);
  } catch (error) {
    console.error(`Error executing tool ${toolName}:`, error);
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

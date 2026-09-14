#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, executeTool, setTopicMonitorInstance } from "./tools/index.js";
import { MattermostClient } from "./client.js";
import { loadConfig, resolveAuthenticationMode } from "./config.js";
import { TopicMonitor } from "./monitor/index.js";
import { AUTHENTICATION_MODES, PROGRESS_NOTIFICATION_METHOD } from "./authentication/constants.js";
import { createStderrAuthenticationLogger, installProcessShutdownHandlers } from "./authentication/runtime.js";
import { createToolCallContext } from "./authentication/session.js";
import { resolveStatePaths } from "./authentication/stateFiles.js";

const AUTHENTICATION_MODE_LOG_PREFIX = "Auth mode:";

const authenticationLogger = createStderrAuthenticationLogger();

async function main() {
  // Check for command-line arguments
  const runMonitoringImmediately = process.argv.includes('--run-monitoring');
  const exitAfterMonitoring = process.argv.includes('--exit-after-monitoring');
  
  console.error("Starting Mattermost MCP Server...");
  
  // Load configuration
  const config = loadConfig();
  if (resolveAuthenticationMode(config) === AUTHENTICATION_MODES.BROWSER) {
    console.error(
      `${AUTHENTICATION_MODE_LOG_PREFIX} ${AUTHENTICATION_MODES.BROWSER} (state directory ${resolveStatePaths().stateDirectory})`
    );
  } else {
    console.error(`${AUTHENTICATION_MODE_LOG_PREFIX} ${AUTHENTICATION_MODES.STATIC}`);
  }

  // Initialize Mattermost client
  let client: MattermostClient;
  try {
    client = new MattermostClient({ config });
    console.error("Successfully initialized Mattermost client");
  } catch (error) {
    console.error("Failed to initialize Mattermost client:", error);
    process.exit(1);
  }
  
  // Initialize and start topic monitor if enabled
  let topicMonitor: TopicMonitor | null = null;
  if (config.monitoring?.enabled) {
    try {
      console.error("Initializing topic monitor...");
      topicMonitor = new TopicMonitor(client, config.monitoring);
      /* В браузерном режиме start() без токена отклоняется: неинициализированный экземпляр не отдаётся инструменту, и тот создаст свой после входа */
      if (client.authenticationMode === AUTHENTICATION_MODES.BROWSER) {
        await topicMonitor.start();
        setTopicMonitorInstance(topicMonitor);
      } else {
        setTopicMonitorInstance(topicMonitor);
        await topicMonitor.start();
      }
      console.error("Topic monitor started successfully");
    } catch (error) {
      console.error("Failed to initialize topic monitor:", error);
      // Continue without monitoring
    }
  } else {
    console.error("Topic monitoring is disabled in configuration");
  }

  /* Окно Chromium может быть открыто во время вызова: сервер завершается по SIGTERM и SIGHUP, а обработчик exit Playwright закрывает браузер */
  if (client.authenticationMode === AUTHENTICATION_MODES.BROWSER) {
    installProcessShutdownHandlers(() => topicMonitor?.stop());
  }

  // Initialize MCP server
  const server = new Server(
    {
      name: "Mattermost MCP Server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("Received ListToolsRequest");
    return {
      tools,
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest, extra) => {
    console.error(`Received CallToolRequest for tool: ${request.params.name}`);
    const callContext = createToolCallContext({
      progressToken: request.params._meta?.progressToken,
      sendProgressNotification: (parameters) =>
        server.notification({ method: PROGRESS_NOTIFICATION_METHOD, params: parameters }),
      cancellationSignal: extra.signal,
      logger: authenticationLogger,
    });

    try {
      if (!request.params.arguments) {
        throw new Error("No arguments provided");
      }

      return await executeTool(client, request.params.name, request.params.arguments, callContext);
    } catch (error) {
      console.error("Error executing tool:", error);
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
  });

  // Connect to transport
  const transport = new StdioServerTransport();
  console.error("Connecting server to transport...");
  await server.connect(transport);

  console.error("Mattermost MCP Server running on stdio");
  
  // Run monitoring immediately if requested
  if (runMonitoringImmediately && topicMonitor) {
    console.error("Running monitoring immediately as requested...");
    try {
      await topicMonitor.runNow();
      
      // Exit after monitoring if requested
      if (exitAfterMonitoring) {
        console.error("Exiting after monitoring as requested...");
        process.exit(0);
      }
    } catch (error) {
      console.error("Error running monitoring immediately:", error);
      
      // Exit with error code if exit-after-monitoring is set
      if (exitAfterMonitoring) {
        console.error("Exiting with error...");
        process.exit(1);
      }
    }
  }
  
  // Handle process termination
  process.on('SIGINT', () => {
    console.error("Shutting down Mattermost MCP Server...");
    if (topicMonitor) {
      topicMonitor.stop();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

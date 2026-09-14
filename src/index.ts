#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools/index.js";
import { startAndRegisterTopicMonitor } from "./tools/monitoring.js";
import { createCallToolHandler } from "./callToolHandler.js";
import { MattermostClient } from "./client.js";
import { describeUnencryptedMattermostUrl, loadConfig, resolveAuthenticationMode } from "./config.js";
import { TopicMonitor } from "./monitor/index.js";
import {
  AUTHENTICATION_MODES,
  AUTHENTICATION_MODE_LOG_PREFIX,
  SERVER_SHUTDOWN_MESSAGE,
} from "./authentication/constants.js";
import { createStderrAuthenticationLogger, installProcessShutdownHandlers } from "./authentication/runtime.js";
import { resolveStatePaths } from "./authentication/stateFiles.js";

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
    const unencryptedUrlWarning = describeUnencryptedMattermostUrl(config.mattermostUrl);
    if (unencryptedUrlWarning !== undefined) {
      authenticationLogger(unencryptedUrlWarning);
    }
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
      await startAndRegisterTopicMonitor(topicMonitor, client.authenticationMode);
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
    installProcessShutdownHandlers(() => {
      console.error(SERVER_SHUTDOWN_MESSAGE);
      topicMonitor?.stop();
    });
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
  server.setRequestHandler(
    CallToolRequestSchema,
    createCallToolHandler({ server, client, logger: authenticationLogger }),
  );

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
    console.error(SERVER_SHUTDOWN_MESSAGE);
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

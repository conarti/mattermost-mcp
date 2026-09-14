import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MattermostClient } from "../client.js";
import { TopicMonitor } from "../monitor/index.js";
import { AuthenticationMode, MonitoringConfig, loadConfig } from "../config.js";
import { AUTHENTICATION_MODES } from "../authentication/constants.js";

// Global reference to the TopicMonitor instance
let topicMonitorInstance: TopicMonitor | null = null;
/* Запуск браузерного режима, общий для параллельных вызовов инструмента; после ошибки сбрасывается */
let browserModeStart: Promise<TopicMonitor> | null = null;

// Set the TopicMonitor instance
export function setTopicMonitorInstance(instance: TopicMonitor): void {
  topicMonitorInstance = instance;
}

/**
 * Запускает монитор и регистрирует его для инструмента. Статический режим регистрирует экземпляр до start, как в 1.1.2.
 * Браузерный режим регистрирует только после успешного start: без токена start отклоняется, и инструмент создаст монитор после входа
 * @returns монитор, зарегистрированный для инструмента
 */
export async function startAndRegisterTopicMonitor(
  topicMonitor: TopicMonitor,
  authenticationMode: AuthenticationMode,
): Promise<TopicMonitor> {
  if (authenticationMode !== AUTHENTICATION_MODES.BROWSER) {
    topicMonitorInstance = topicMonitor;
    await topicMonitor.start();
    return topicMonitor;
  }

  if (browserModeStart === null) {
    browserModeStart = topicMonitor.start().then(
      () => {
        topicMonitorInstance = topicMonitor;
        return topicMonitor;
      },
      (error: unknown) => {
        browserModeStart = null;
        throw error;
      },
    );
  }
  return browserModeStart;
}

// Tool definition for running monitoring immediately
export const runMonitoringTool: Tool = {
  name: "mattermost_run_monitoring",
  description: "Run the topic monitoring process immediately",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
};

// Handler for the run monitoring tool
export async function handleRunMonitoring(
  client: MattermostClient,
  args: any,
  loadMonitoringConfig: () => MonitoringConfig | undefined = () => loadConfig().monitoring,
) {
  try {
    /* Монитор всегда фоновый, поэтому вход через окно возможен только здесь, в контексте вызова инструмента. Вход идёт после проверки конфигурации, чтобы выключенный мониторинг не открывал окно */
    const browserMode = client.authenticationMode === AUTHENTICATION_MODES.BROWSER;
    let topicMonitor = topicMonitorInstance;

    if (!topicMonitor) {
      // If no instance is set, create a new one
      const monitoringConfig = loadMonitoringConfig();
      if (!monitoringConfig?.enabled) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Topic monitoring is disabled in configuration",
              }),
            },
          ],
          isError: true,
        };
      }

      if (browserMode) {
        await client.getMe();
      }
      topicMonitor = await startAndRegisterTopicMonitor(new TopicMonitor(client, monitoringConfig), client.authenticationMode);
    } else if (browserMode) {
      await client.getMe();
    }

    // Run the monitoring process
    await topicMonitor.runNow();
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: "Topic monitoring process executed successfully",
          }),
        },
      ],
    };
  } catch (error) {
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

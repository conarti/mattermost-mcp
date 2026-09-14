import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { PROGRESS_NOTIFICATION_METHOD } from "./authentication/constants.js";
import type { AuthenticationLogger } from "./authentication/runtime.js";
import { createToolCallContext } from "./authentication/session.js";
import type { MattermostClient } from "./client.js";
import { executeTool } from "./tools/index.js";

export interface CallToolHandlerDependencies {
  /** Нужна только отправка уведомлений о прогрессе входа */
  server: Pick<Server, "notification">;
  client: MattermostClient;
  logger: AuthenticationLogger;
}

/** Обработчик tools/call: инструмент получает интерактивный контекст с прогрессом по progressToken и сигналом отмены клиента */
export function createCallToolHandler({ server, client, logger }: CallToolHandlerDependencies) {
  return async (request: CallToolRequest, extra: RequestHandlerExtra) => {
    console.error(`Received CallToolRequest for tool: ${request.params.name}`);
    const callContext = createToolCallContext({
      progressToken: request.params._meta?.progressToken,
      sendProgressNotification: (parameters) =>
        server.notification({ method: PROGRESS_NOTIFICATION_METHOD, params: parameters }),
      cancellationSignal: extra.signal,
      logger,
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
  };
}

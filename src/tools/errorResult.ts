export function createErrorResult(message: string) {
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

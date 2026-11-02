import type { RuntimeHooks } from "@hina/core";

/** 演示行为单独装配，不放进 Channel 或 Runtime 内核。 */
export function demoHooks(): RuntimeHooks {
  return {
    beforeHandle: ({ event }) => (event.content.text === "/observe" ? "observe" : "continue"),
    handle: ({ event }) => [
      {
        type: "message.send",
        target: { ...event.origin, conversationId: event.conversationId },
        content: { type: "text", text: `回声：${event.content.text}` },
      },
    ],
    beforeSend: ({ action, event }) =>
      action.target.channelId === "mock" &&
      action.target.accountId === "local" &&
      action.target.conversationId === event.conversationId
        ? "allow"
        : "deny",
  };
}

import { fileURLToPath } from "node:url";

// src 与 dist 位于同一层级，源码和构建产物使用同一个项目私有目录。
export const qqCredentialsFile = fileURLToPath(
  new URL("../../../.hina/qqbot.json", import.meta.url),
);
export const qqQrFile = fileURLToPath(new URL("../../../.hina/qq-login.png", import.meta.url));
export const messageLogFile = fileURLToPath(
  new URL("../../../.hina/messages.sqlite", import.meta.url),
);
export const dashboardDirectory = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
export const llmSettingsFile = fileURLToPath(
  new URL("../../../.hina/llm-settings.enc", import.meta.url),
);

export interface LlmSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly decisionModel: string;
  readonly decisionThreshold: number;
  readonly systemPrompt: string;
  readonly enabled: boolean;
  readonly replyScope: "direct" | "direct-and-groups";
  readonly includeImages: boolean;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}

export interface PublicLlmSettings extends LlmSettings {
  readonly revision: number;
  readonly hasToken: boolean;
}

export interface LlmSettingsUpdate extends LlmSettings {
  readonly expectedRevision: number;
  readonly token?: string;
}

export const defaultLlmSettings: LlmSettings = Object.freeze({
  endpoint: "",
  model: "",
  decisionModel: "",
  decisionThreshold: 0.7,
  systemPrompt:
    "你是 Hina，一个持续参与对话的数字角色。用简洁、自然的中文回复。没有提供图片时，不声称看过图片。",
  enabled: false,
  replyScope: "direct",
  includeImages: false,
  timeoutMs: 20_000,
  maxOutputTokens: 1024,
});

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("配置数据无效");
  return value as Record<string, unknown>;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError("配置数值超出范围");
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function parseSecretToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    hasControlCharacters(value)
  )
    throw new TypeError("Secret Token 格式无效");
  return value.trim();
}

export function normalizeEndpoint(
  input: string,
  resource: "responses" | "decisions" = "responses",
): string {
  const url = new URL(input.trim());
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (/^127(?:\.\d{1,3}){3}$/.test(url.hostname) &&
      url.hostname.split(".").every((part) => Number(part) <= 255));
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError("API 地址必须使用 HTTPS（本机接口可用 HTTP），且不能包含账号、参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|decisions)$/, "");
  url.pathname += `/${resource}`;
  return url.href;
}

export function parseLlmSettings(input: unknown, incomplete = false): LlmSettings {
  const value = object(input);
  if (
    typeof value.endpoint !== "string" ||
    value.endpoint.length > 2048 ||
    typeof value.model !== "string" ||
    value.model.length > 128 ||
    typeof value.decisionModel !== "string" ||
    value.decisionModel.length > 128 ||
    typeof value.decisionThreshold !== "number" ||
    !Number.isFinite(value.decisionThreshold) ||
    value.decisionThreshold < 0 ||
    value.decisionThreshold > 1 ||
    typeof value.systemPrompt !== "string" ||
    value.systemPrompt.length > 8000 ||
    typeof value.enabled !== "boolean" ||
    typeof value.includeImages !== "boolean" ||
    (value.replyScope !== "direct" && value.replyScope !== "direct-and-groups")
  )
    throw new TypeError("模型配置字段无效");
  const model = value.model.trim();
  if ((!model || !value.endpoint.trim()) && !incomplete)
    throw new TypeError("请填写 API 地址和模型名称");
  const decisionModel = value.decisionModel.trim();
  if (hasControlCharacters(model) || hasControlCharacters(decisionModel))
    throw new TypeError("模型名称无效");
  return Object.freeze({
    endpoint: value.endpoint.trim() ? normalizeEndpoint(value.endpoint) : "",
    model,
    decisionModel,
    decisionThreshold: value.decisionThreshold,
    systemPrompt: value.systemPrompt,
    enabled: value.enabled,
    includeImages: value.includeImages,
    replyScope: value.replyScope,
    timeoutMs: integer(value.timeoutMs, 1000, 30_000),
    maxOutputTokens: integer(value.maxOutputTokens, 64, 4096),
  });
}

/** 仅识别已发布的旧配置；缺失新字段的未知格式仍拒绝加载。 */
export function migrateLlmSettings(input: unknown): LlmSettings {
  const value = object(input);
  if (
    value.decisionModel === undefined &&
    (value.tokenParameter === "max_tokens" || value.tokenParameter === "max_completion_tokens") &&
    (value.replyScope === "direct" || value.replyScope === "direct-and-mentions")
  )
    return parseLlmSettings({
      ...value,
      decisionModel: "",
      decisionThreshold: 0.7,
      replyScope: value.replyScope === "direct" ? "direct" : "direct-and-groups",
    });
  return parseLlmSettings(value);
}

export function parseSettingsUpdate(input: unknown): LlmSettingsUpdate {
  const value = object(input);
  const settings = parseLlmSettings(value);
  const token = value.token === undefined ? undefined : parseSecretToken(value.token);
  return {
    ...settings,
    expectedRevision: integer(value.expectedRevision, 0, 1_000_000_000),
    ...(token === undefined ? {} : { token }),
  };
}

export function parsePublicSettings(input: unknown): PublicLlmSettings {
  const value = object(input);
  if (typeof value.hasToken !== "boolean") throw new TypeError("凭据状态无效");
  return {
    ...parseLlmSettings(value, true),
    hasToken: value.hasToken,
    revision: integer(value.revision, 0, 1_000_000_000),
  };
}

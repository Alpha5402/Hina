import type { MessageLogEntry } from "@hina/logs";

export function processingLabel(entry: MessageLogEntry): string {
  const processing = entry.processing;
  if (!processing) return "已接收";
  if (processing.status === "skipped")
    return {
      disabled: "仅接收",
      "not-configured": "未配置",
      scope: "已过滤",
      "images-disabled": "未启用识图",
      "image-limit": "图片超限",
      "input-limit": "输入超限",
      budget: "限流",
      "configuration-unavailable": "配置不可用",
      "decision-threshold": "不回复",
      "decision-refused": "决策拒绝",
    }[processing.reason];
  return {
    deciding: "决策中",
    generating: "生成中",
    generated: "已生成",
    sending: "发送中",
    sent: "已回复",
    blocked: "已拦截",
    failed: processing.status === "failed" && processing.stage === "send" ? "发送未确认" : "失败",
  }[processing.status];
}

export function decisionLabel(entry: MessageLogEntry): string {
  const decision = entry.processing?.decision;
  if (!decision) return "—";
  if (decision.status === "skipped") return "已跳过";
  if (decision.status === "evaluating")
    return entry.processing?.status === "failed" ? "失败" : "判断中";
  return decision.result.type === "refusal"
    ? "拒绝判断"
    : `${(decision.result.probability * 100).toFixed(1)}%`;
}

export function processingError(entry: MessageLogEntry): string {
  const value = entry.processing;
  if (value?.status !== "failed") return "";
  const messages: Record<string, string> = {
    provider_auth: "模型凭据未通过认证",
    provider_refusal: "响应模型拒绝生成回复",
    provider_rejected: "模型拒绝请求，请检查模型名称和参数",
    provider_quota: "API 额度或计费受限，请检查余额和使用限额",
    provider_model: "模型不存在或当前 API Key 没有访问权限",
    provider_access: "模型接口拒绝访问，请检查项目和 API Key 权限",
    provider_parameter: "模型接口不接受当前参数，请检查请求设置",
    provider_token_parameter: "接口不兼容当前 Responses 请求，请检查 API 地址和服务能力",
    provider_rate_limit: "模型接口限流，请稍后再试",
    provider_timeout: "模型响应超时",
    provider_network: "模型接口连接失败",
    invalid_response: "模型响应格式无效",
    cancelled: "请求因停止或配置变更而取消",
    busy: "模型接口限流",
    delivery_unconfirmed: "发送未确认，不会自动重复发送",
    interrupted: "上次处理因进程重启而中断，不会自动重试",
  };
  return messages[value.code] ?? "处理失败";
}

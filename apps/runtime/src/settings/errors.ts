export type ServiceErrorCode =
  | "invalid_config"
  | "stale_config"
  | "token_required"
  | "endpoint_changed"
  | "vault_locked"
  | "secure_storage"
  | "save_failed"
  | "not_configured"
  | "provider_auth"
  | "provider_rejected"
  | "provider_quota"
  | "provider_model"
  | "provider_access"
  | "provider_parameter"
  | "provider_token_parameter"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_network"
  | "invalid_response"
  | "cancelled"
  | "busy";

const messages: Record<ServiceErrorCode, string> = {
  invalid_config: "模型配置无效",
  stale_config: "配置已被更新，请重新读取后保存",
  token_required: "请输入 Secret Token",
  endpoint_changed: "更换 API 地址后请重新输入 Token",
  vault_locked: "无法解密模型配置，请检查系统凭据库",
  secure_storage: "无法访问系统凭据库，未保存明文凭据",
  save_failed: "模型配置保存失败",
  not_configured: "尚未配置模型",
  provider_auth: "模型接口拒绝了凭据",
  provider_rejected: "模型接口拒绝了请求，请核对模型和参数",
  provider_quota: "API 额度或计费受限，请检查余额和使用限额",
  provider_model: "模型不存在或当前 API Key 没有访问权限",
  provider_access: "模型接口拒绝访问，请检查项目和 API Key 权限",
  provider_parameter: "模型接口不接受当前参数，请检查请求设置",
  provider_token_parameter:
    "该模型不接受 max_tokens，请将 Token 限制参数改为 max_completion_tokens",
  provider_rate_limit: "模型接口限流，请稍后再试",
  provider_timeout: "模型请求超时",
  provider_network: "无法连接模型接口",
  invalid_response: "模型返回的数据不符合约定",
  cancelled: "操作已取消",
  busy: "模型调用已达当前预算，请稍后再试",
};

export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode) {
    super(messages[code]);
    this.name = "ServiceError";
  }
}

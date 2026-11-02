import { object } from "@hina/settings";
import { readLimitedJson } from "../http";
import { ServiceError } from "../settings/errors";

export async function providerError(
  response: Response,
  signal: AbortSignal,
): Promise<ServiceError> {
  let code: unknown;
  let parameter: unknown;
  try {
    const body = object(await readLimitedJson(response.body, 8 * 1024, signal));
    const error = object(body.error);
    code = error.code;
    parameter = error.param;
  } catch {
    // 只保留白名单类别，不把远端错误正文、参数值或请求信息带入日志。
  }
  if (code === "invalid_api_key" || response.status === 401)
    return new ServiceError("provider_auth");
  if (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code === "billing_not_active"
  )
    return new ServiceError("provider_quota");
  if (code === "model_not_found") return new ServiceError("provider_model");
  if (response.status === 403) return new ServiceError("provider_access");
  if (response.status === 429 || code === "rate_limit_exceeded")
    return new ServiceError("provider_rate_limit");
  if (response.status === 400 && parameter === "max_tokens")
    return new ServiceError("provider_token_parameter");
  if (response.status === 400) return new ServiceError("provider_parameter");
  return new ServiceError("provider_rejected");
}

# ADR 0001：模型配置加密与执行边界

状态：已采用。日期：2026-11-03。

模型调用协议部分已由 [ADR 0002](./0002-optional-decision-and-responses.md) 替代；凭据加密与副作用边界继续适用。

## 原因

本机管理页需要配置用户已有的模型接口和 Token，并把 QQ 输入、模型响应和输出关联起来。普通文件权限不足以满足加密存储；仅将密钥写进邻近文件也无法保护一并复制的配置。核心不能依赖 Bun、平台 SDK 或供应商 API，模型不能绕过统一 Action 入口发送消息。

## 选择

配置使用 Node 兼容 crypto 的 AES-256-GCM，随机 256 位主密钥、每次随机 96 位 IV、128 位认证标签；格式版本与随机密钥引用作为 AAD。主密钥使用宿主适配器调用 `Bun.secrets` 放入系统凭据库，磁盘只保留密文、IV、标签和引用。写入采用私有临时文件原子替换，配置版本防止并发覆盖；系统凭据库不可用时失败关闭，无明文或环境变量兜底。

前端无 Token 读取接口，只获得 `hasToken`；更换地址要求再次输入 Token，防止持有旧 Key 的表单把它传给新目的地。配置修改取消在途生成并让待发送 Action 重新验证版本。公有 Model 契约放在 core，供应商 HTTP、Token 和超时封装在 Runtime。最小实现使用 Chat Completions 兼容协议，不引入模型 SDK；输出限制参数显式选择，以适配不同服务，禁止通过静默重试增加调用。

模型回复默认关闭，用户独立启用；纯规则门控在调用前检查范围、长度、图片和预算。响应变成 Action 后再检查账号、当前会话、内容和配置，Channel 只执行输出。日志记录安全归一化结果，供应商原始错误体和 Authorization 不落日志；未知失败不会变成成功。

## 取舍与验证

系统凭据库增加宿主依赖，已封装在适配器；Linux 需提供 Secret Service，跨系统行为需各自验证。仅复制密文不能迁移配置，主密钥必须保有。解密后的 Token 在运行进程内存中存在，本方案不宣称抵御当前用户或进程被控制。

已验证加密重开、认证失败、系统密钥缺失、私有权限、首次写入失败的密钥回滚、并发保存、CSRF、配置切换取消与发送前拒绝。本机 macOS 系统凭据库完成随机临时密钥 set/get/delete；真实用户配置和模型调用通过本机页面验证。打包分发、Linux/Windows 凭据库及长期运行尚未验收。

参考：[Bun 系统凭据库](https://bun.com/docs/runtime/secrets)、[Node crypto](https://nodejs.org/api/crypto.html)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

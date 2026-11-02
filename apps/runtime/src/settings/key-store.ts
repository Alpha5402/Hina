import { bounded } from "../operations";
import { ServiceError } from "./errors";

export interface SecretKeyStore {
  get(id: string): Promise<string | null>;
  set(id: string, key: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Bun 的平台差异仅保留在宿主适配器内；不向本地文件退回保存主密钥。 */
export class SystemSecretKeyStore implements SecretKeyStore {
  constructor(private readonly service = "dev.hina.llm") {}
  async get(id: string): Promise<string | null> {
    try {
      return await bounded(() => Bun.secrets.get({ service: this.service, name: id }), 15_000);
    } catch {
      throw new ServiceError("secure_storage");
    }
  }
  async set(id: string, key: string): Promise<void> {
    const pending = Bun.secrets.set({
      service: this.service,
      name: id,
      value: key,
      persist: "local",
    });
    try {
      await bounded(() => pending, 15_000);
    } catch {
      // 原生凭据服务不能取消；迟到成功时补偿删除，只清理由本次新建的独立 ID。
      void pending
        .then(
          () => this.delete(id),
          () => undefined,
        )
        .catch(() => undefined);
      throw new ServiceError("secure_storage");
    }
  }
  async delete(id: string): Promise<void> {
    try {
      await bounded(() => Bun.secrets.delete({ service: this.service, name: id }), 15_000);
    } catch {
      throw new ServiceError("secure_storage");
    }
  }
}

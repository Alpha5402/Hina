import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultLlmSettings,
  integer,
  type LlmSettings,
  type LlmSettingsUpdate,
  migrateLlmSettings,
  object,
  type PublicLlmSettings,
  parseLlmSettings,
  parseSecretToken,
} from "@hina/settings";
import { ServiceError } from "./errors";
import type { SecretKeyStore } from "./key-store";

export interface LlmConfiguration extends LlmSettings {
  readonly revision: number;
  readonly token: string;
}

export class EncryptedSettingsStore {
  private cached: LlmConfiguration | undefined;
  private key: Buffer | undefined;
  private vaultId: string | undefined;
  private initialized = false;
  private loading: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly file: string,
    private readonly keys: SecretKeyStore,
  ) {}

  current(): LlmConfiguration | undefined {
    return this.cached;
  }
  get unavailable(): boolean {
    return !this.initialized;
  }

  async load(): Promise<void> {
    if (this.closed) throw new ServiceError("vault_locked");
    if (this.initialized) return;
    this.loading ??= this.read().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  private async read(): Promise<void> {
    let bytes: string;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64_000)
        throw new ServiceError("vault_locked");
      bytes = await readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.initialized = true;
        return;
      }
      throw new ServiceError("vault_locked");
    }
    let key: Buffer | undefined;
    try {
      const envelope = object(JSON.parse(bytes));
      if (
        envelope.version !== 1 ||
        typeof envelope.vaultId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(envelope.vaultId) ||
        typeof envelope.iv !== "string" ||
        !/^[A-Za-z0-9+/]{16}$/.test(envelope.iv) ||
        typeof envelope.tag !== "string" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(envelope.tag) ||
        typeof envelope.ciphertext !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)
      )
        throw new ServiceError("vault_locked");
      const storedKey = await this.keys.get(envelope.vaultId);
      if (storedKey === null || !/^[A-Za-z0-9+/]{43}=$/.test(storedKey))
        throw new ServiceError("vault_locked");
      key = Buffer.from(storedKey, "base64");
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"), {
        authTagLength: 16,
      });
      cipher.setAAD(Buffer.from(`hina:llm:v1:${envelope.vaultId}`));
      cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([
        cipher.update(Buffer.from(envelope.ciphertext, "base64")),
        cipher.final(),
      ]);
      let payload: Record<string, unknown>;
      try {
        payload = object(JSON.parse(plain.toString("utf8")));
      } finally {
        plain.fill(0);
      }
      const settings = migrateLlmSettings(payload);
      const token = parseSecretToken(payload.token);
      this.cached = Object.freeze({
        ...settings,
        token,
        revision: integer(payload.revision, 1, 1_000_000_000),
      });
      this.key = Buffer.from(key);
      this.vaultId = envelope.vaultId;
      this.initialized = true;
    } catch (error) {
      throw error instanceof ServiceError ? error : new ServiceError("vault_locked");
    } finally {
      key?.fill(0);
    }
  }

  async publicView(): Promise<PublicLlmSettings> {
    await this.load();
    const current = this.cached;
    return {
      ...parseLlmSettings(current ?? defaultLlmSettings, true),
      hasToken: Boolean(current?.token),
      revision: current?.revision ?? 0,
    };
  }

  async candidate(update: LlmSettingsUpdate): Promise<LlmConfiguration> {
    await this.load();
    const current = this.cached;
    if (update.expectedRevision !== (current?.revision ?? 0))
      throw new ServiceError("stale_config");
    const settings = parseLlmSettings(update);
    if (current && settings.endpoint !== current.endpoint && !update.token)
      throw new ServiceError("endpoint_changed");
    const token = update.token ?? current?.token;
    if (!token) throw new ServiceError("token_required");
    if (
      token.length >= 8 &&
      [settings.endpoint, settings.model, settings.decisionModel, settings.systemPrompt].some(
        (field) => field.includes(token),
      )
    )
      throw new ServiceError("invalid_config");
    return Object.freeze({ ...settings, revision: (current?.revision ?? 0) + 1, token });
  }

  save(update: LlmSettingsUpdate): Promise<PublicLlmSettings> {
    const task = this.writing.then(() => this.persist(update));
    this.writing = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async persist(update: LlmSettingsUpdate): Promise<PublicLlmSettings> {
    const candidate = await this.candidate(update);
    const key = this.key ? Buffer.from(this.key) : randomBytes(32);
    const vaultId = this.vaultId ?? randomUUID();
    const created = !this.vaultId;
    let keyCreated = false;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const parent = await lstat(dirname(this.file));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ServiceError("save_failed");
      await chmod(dirname(this.file), 0o700);
      try {
        const stat = await lstat(this.file);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new ServiceError("save_failed");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (created) {
        await this.keys.set(vaultId, key.toString("base64"));
        keyCreated = true;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(`hina:llm:v1:${vaultId}`));
      const plain = Buffer.from(JSON.stringify(candidate));
      let ciphertext: Buffer;
      try {
        if (plain.length > 32 * 1024) throw new ServiceError("invalid_config");
        ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      } finally {
        plain.fill(0);
      }
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          vaultId,
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, this.file);
      this.key?.fill(0);
      this.key = Buffer.from(key);
      this.vaultId = vaultId;
      this.cached = candidate;
      this.initialized = true;
      for (const listener of this.listeners) listener();
      return this.publicView();
    } catch (error) {
      if (keyCreated && this.vaultId !== vaultId)
        await this.keys.delete(vaultId).catch(() => undefined);
      throw error instanceof ServiceError ? error : new ServiceError("save_failed");
    } finally {
      key.fill(0);
      await unlink(temporary).catch(() => undefined);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async close(): Promise<void> {
    await this.writing;
    await this.loading?.catch(() => undefined);
    this.closed = true;
    this.key?.fill(0);
    this.key = undefined;
    this.cached = undefined;
    this.listeners.clear();
  }
}

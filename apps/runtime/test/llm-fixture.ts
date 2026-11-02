import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLlmSettings, type LlmSettingsUpdate, parseSettingsUpdate } from "@hina/settings";
import type { SecretKeyStore } from "../src/settings/key-store";
import { EncryptedSettingsStore } from "../src/settings/store";

export const fixtureToken = "fixture-llm-token-not-a-real-key";
export function responsePayload(text = "这是模型回复") {
  return {
    model: "fixture-model",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  };
}
export class MemoryKeyStore implements SecretKeyStore {
  readonly values = new Map<string, string>();
  sets = 0;
  onSet: (() => Promise<void>) | undefined;
  async get(id: string) {
    return this.values.get(id) ?? null;
  }
  async set(id: string, value: string) {
    this.sets += 1;
    this.values.set(id, value);
    await this.onSet?.();
  }
  async delete(id: string) {
    this.values.delete(id);
  }
}

export function settingsUpdate(changes: Partial<LlmSettingsUpdate> = {}): LlmSettingsUpdate {
  return parseSettingsUpdate({
    ...defaultLlmSettings,
    endpoint: "https://models.example.test/v1",
    model: "fixture-model",
    expectedRevision: 0,
    token: fixtureToken,
    ...changes,
  });
}

export async function settingsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "hina-llm-"));
  const file = join(directory, "private", "llm-settings.enc");
  const keys = new MemoryKeyStore();
  const store = new EncryptedSettingsStore(file, keys);
  return {
    directory,
    file,
    keys,
    store,
    async cleanup() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { parseSettingsUpdate } from "@hina/settings";
import { startLogServer } from "../src/logs/server";
import { SQLiteMessageLogStore } from "../src/logs/store";
import { EncryptedSettingsStore } from "../src/settings/store";
import { fixtureToken, responsePayload, settingsFixture, settingsUpdate } from "./llm-fixture";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const value = await settingsFixture();
  cleanups.push(value.cleanup);
  return value;
}

describe("加密模型配置", () => {
  test("旧配置保留凭据并迁移到 Responses，决策默认未配置", async () => {
    const { store, file, keys } = await fixture();
    await store.save(settingsUpdate());
    const envelope = JSON.parse(await readFile(file, "utf8"));
    const value = keys.values.get(envelope.vaultId);
    if (!value) throw new Error("测试主密钥缺失");
    const {
      decisionModel: _decision,
      decisionThreshold: _threshold,
      ...legacy
    } = store.current() ?? {};
    const iv = randomBytes(12);
    const key = Buffer.from(value, "base64");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`hina:llm:v1:${envelope.vaultId}`));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          ...legacy,
          endpoint: "https://models.example.test/v1/chat/completions",
          replyScope: "direct-and-mentions",
          tokenParameter: "max_completion_tokens",
        }),
      ),
      cipher.final(),
    ]);
    await writeFile(
      file,
      JSON.stringify({
        ...envelope,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
    );
    key.fill(0);
    const migrated = new EncryptedSettingsStore(file, keys);
    cleanups.push(() => migrated.close());
    const publicSettings = await migrated.publicView();
    expect(publicSettings).toMatchObject({
      model: "fixture-model",
      endpoint: "https://models.example.test/v1/responses",
      decisionModel: "",
      decisionThreshold: 0.7,
      replyScope: "direct-and-groups",
      hasToken: true,
      revision: 1,
    });
    expect(migrated.current()?.token).toBe(fixtureToken);
    expect("tokenParameter" in publicSettings).toBe(false);
    expect(keys.sets).toBe(1);
    expect(() => settingsUpdate({ decisionThreshold: 1.1 })).toThrow();
    expect(() => settingsUpdate({ decisionThreshold: NaN })).toThrow();
    expect(() => settingsUpdate({ decisionModel: "bad\nmodel" })).toThrow();
  });
  test("Token 和配置只以密文落盘，重开可解密，公共响应不回显秘密", async () => {
    const { store, file, keys } = await fixture();
    const saved = await store.save(settingsUpdate());
    const disk = await readFile(file, "utf8");
    expect(disk.includes(fixtureToken)).toBe(false);
    expect(disk.includes("models.example.test")).toBe(false);
    expect(disk.includes("fixture-model")).toBe(false);
    expect(JSON.stringify(saved).includes(fixtureToken)).toBe(false);
    expect(saved.hasToken).toBe(true);
    expect(saved.revision).toBe(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(keys.sets).toBe(1);
    const reopened = new EncryptedSettingsStore(file, keys);
    cleanups.push(() => reopened.close());
    await reopened.load();
    expect(reopened.current()?.token).toBe(fixtureToken);
    const { token: _token, ...preserved } = settingsUpdate({ expectedRevision: 1, enabled: true });
    const updated = await reopened.save(preserved);
    expect(updated.revision).toBe(2);
    expect(keys.sets).toBe(1);
    expect("token" in updated).toBe(false);
  });

  test("更换 API 地址必须重新输入 Token，陈旧表单和并发保存不能覆盖配置", async () => {
    const { store } = await fixture();
    await store.save(settingsUpdate());
    const { token: _token, ...withoutToken } = settingsUpdate({ expectedRevision: 1 });
    await expect(
      store.save({ ...withoutToken, endpoint: "https://other.example.test/chat/completions" }),
    ).rejects.toMatchObject({ code: "endpoint_changed" });
    await expect(store.save(settingsUpdate())).rejects.toMatchObject({ code: "stale_config" });
    const outcomes = await Promise.allSettled([
      store.save({ ...withoutToken, model: "next-a" }),
      store.save({ ...withoutToken, model: "next-b" }),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((await store.publicView()).model).toBe("next-a");
  });

  test("篡改密文、缺失主密钥和不安全文件权限不会降级为空配置", async () => {
    const { store, file, keys } = await fixture();
    await store.save(settingsUpdate());
    const original = await readFile(file, "utf8");
    const envelope = JSON.parse(original);
    envelope.ciphertext =
      (envelope.ciphertext.startsWith("A") ? "B" : "A") + envelope.ciphertext.slice(1);
    await writeFile(file, JSON.stringify(envelope));
    const broken = new EncryptedSettingsStore(file, keys);
    cleanups.push(() => broken.close());
    await expect(broken.publicView()).rejects.toMatchObject({ code: "vault_locked" });
    await writeFile(file, original);
    keys.values.clear();
    const missing = new EncryptedSettingsStore(file, keys);
    cleanups.push(() => missing.close());
    await expect(missing.load()).rejects.toMatchObject({ code: "vault_locked" });
    await chmod(file, 0o644);
    const openFile = new EncryptedSettingsStore(file, keys);
    cleanups.push(() => openFile.close());
    await expect(openFile.load()).rejects.toMatchObject({ code: "vault_locked" });
  });

  test("首次保存失败清理新建主密钥，配置校验不接受明文 URL Token 或控制字符", async () => {
    const { store, file, keys } = await fixture();
    keys.onSet = async () => {
      await mkdir(file);
    };
    await expect(store.save(settingsUpdate())).rejects.toMatchObject({ code: "save_failed" });
    expect(keys.values.size).toBe(0);
    expect(() => settingsUpdate({ endpoint: "https://user:secret@example.test/v1" })).toThrow();
    expect(() => settingsUpdate({ endpoint: "https://example.test/v1?token=hidden" })).toThrow();
    expect(() => settingsUpdate({ endpoint: "http://example.test/v1" })).toThrow();
    expect(() => settingsUpdate({ endpoint: "http://127.attacker.example/v1" })).toThrow();
    expect(settingsUpdate({ endpoint: "http://127.0.0.2:3412/v1" }).endpoint).toBe(
      "http://127.0.0.2:3412/v1/responses",
    );
    expect(() => settingsUpdate({ token: "fixture\nheader" })).toThrow();
    expect(() => settingsUpdate({ maxOutputTokens: 99_999 })).toThrow();
  });
});

describe("设置接口", () => {
  test("写入有 CSRF/Origin/JSON 校验，连接测试不发送 QQ 或回显 Token", async () => {
    const { store } = await fixture();
    const logs = new SQLiteMessageLogStore(":memory:");
    cleanups.push(() => logs.close());
    const requests: { authorization: string | null; body: unknown }[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          authorization: request.headers.get("Authorization"),
          body: await request.json(),
        });
        return Response.json(
          request.url.endsWith("/decisions")
            ? {
                model: "gpt-6-luna",
                answers: [{ type: "predicate", name: "should_reply", probability: 0.95 }],
                usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
              }
            : responsePayload(`OK ${fixtureToken}`),
        );
      },
    });
    cleanups.push(() => provider.stop(true));
    const server = startLogServer({
      store: logs,
      settings: store,
      assetsDirectory: "/not-used",
      connection: () => "online",
      replyEnabled: false,
      port: 0,
    });
    cleanups.push(() => server.stop());
    const first = await (await fetch(`${server.url}/api/llm/settings`)).json();
    expect(first.settings.hasToken).toBe(false);
    expect(first.settings.enabled).toBe(false);
    const update = settingsUpdate({ endpoint: `http://127.0.0.1:${provider.port}/v1` });
    const base = {
      "Content-Type": "application/json",
      "X-Hina-CSRF": first.csrfToken,
      Origin: server.url,
    };
    const mutate = (
      headers: Record<string, string>,
      body: unknown,
      path = "settings",
      method = "PUT",
    ) => fetch(`${server.url}/api/llm/${path}`, { method, headers, body: JSON.stringify(body) });
    expect((await mutate({ ...base, Origin: "https://example.com" }, update)).status).toBe(403);
    expect((await mutate({ ...base, "X-Hina-CSRF": "wrong" }, update)).status).toBe(403);
    expect((await mutate({ ...base, "Content-Type": "text/plain" }, update)).status).toBe(403);
    const saved = await mutate(base, update);
    expect(saved.status).toBe(200);
    const publicData = await saved.json();
    expect(JSON.stringify(publicData).includes(fixtureToken)).toBe(false);
    const { token: _token, ...testUpdate } = parseSettingsUpdate({
      ...update,
      expectedRevision: 1,
    });
    const tested = await mutate(base, testUpdate, "test", "POST");
    expect(tested.status).toBe(200);
    const result = await tested.json();
    expect(result.response.text).toContain("OK");
    expect(JSON.stringify(result).includes(fixtureToken)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${fixtureToken}`);
    expect(requests[0]?.body).toMatchObject({
      model: "fixture-model",
      stream: false,
      max_output_tokens: 512,
      store: false,
      input: [{ role: "user", content: "请只回复 OK。" }],
    });
    expect((await mutate(base, testUpdate, "test-decision", "POST")).status).toBe(400);
    expect(
      (
        await mutate(
          { ...base, "X-Hina-CSRF": "wrong" },
          { ...testUpdate, decisionModel: "gpt-6-luna" },
          "test-decision",
          "POST",
        )
      ).status,
    ).toBe(403);
    const evaluated = await mutate(
      base,
      { ...testUpdate, decisionModel: "gpt-6-luna" },
      "test-decision",
      "POST",
    );
    expect(evaluated.status).toBe(200);
    const decision = await evaluated.json();
    expect(decision).toMatchObject({
      decision: { type: "probability", probability: 0.95 },
      passed: true,
      threshold: 0.7,
    });
    expect(JSON.stringify(decision)).not.toContain(fixtureToken);
    expect(requests).toHaveLength(2);
    expect(store.current()?.revision).toBe(1);
    expect(
      logs.query({
        search: "",
        channel: "",
        category: "all",
        contentType: "all",
        page: 1,
        pageSize: 25,
      }).retainedCount,
    ).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvent, type RuntimeEvent } from "@hina/core";
import { parseLogQuery, parseLogResponse } from "@hina/logs";
import { fetchImage, validateImageUrl } from "../src/logs/images";
import { startLogServer } from "../src/logs/server";
import { SQLiteMessageLogStore } from "../src/logs/store";
import { LogStreams } from "../src/logs/stream";
import { QQChannel } from "../src/qq/channel";
import { qqHooks } from "../src/qq/hooks";
import { Runtime } from "../src/runtime";
import { credentials, FakeQQClient, qqMessage } from "./qq-fixture";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const query = (value = "") => parseLogQuery(new URLSearchParams(value));
function event(id: string, changes: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return parseEvent({
    id,
    origin: { channelId: "qq", accountId: "fixture-account" },
    timestamp: "2026-11-03T00:00:00Z",
    actorId: "fixture-user",
    conversationId: "fixture-room",
    conversationType: "direct",
    content: { type: "text", text: `测试消息 ${id}` },
    ...changes,
  });
}
function store(capacity?: number) {
  const result = new SQLiteMessageLogStore(":memory:", capacity);
  cleanups.push(() => result.close());
  return result;
}
const image = {
  type: "image" as const,
  url: "https://multimedia.nt.qq.com.cn/download?fixture=1",
  mediaType: "image/png",
};

describe("按消息记录", () => {
  test("v1 日志迁移保留原始消息，未完成调用在明确恢复入口标记中断而不重放", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hina-log-migration-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const file = join(folder, "messages.sqlite");
    const legacy = new Database(file);
    legacy.exec(
      `CREATE TABLE messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,account TEXT NOT NULL,conversation TEXT NOT NULL,event_id TEXT NOT NULL,category TEXT NOT NULL,content_kind TEXT NOT NULL,actor TEXT NOT NULL,text TEXT NOT NULL,received_at TEXT NOT NULL,event_json TEXT NOT NULL,UNIQUE(channel,account,conversation,event_id)); PRAGMA user_version=1;`,
    );
    const original = event("legacy");
    legacy
      .query(
        "INSERT INTO messages(channel,account,conversation,event_id,category,content_kind,actor,text,received_at,event_json)VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        original.origin.channelId,
        original.origin.accountId,
        original.conversationId,
        original.id,
        "direct",
        "text",
        original.actorId,
        original.content.text,
        original.timestamp,
        JSON.stringify(original),
      );
    legacy.close();
    await chmod(file, 0o600);
    const migrated = new SQLiteMessageLogStore(file);
    cleanups.push(() => migrated.close());
    expect(migrated.find(1)?.content.text).toBe(original.content.text);
    expect(migrated.find(1)?.processingVersion).toBe(0);
    migrated.recordProcessing(original, {
      status: "generating",
      startedAt: new Date().toISOString(),
    });
    expect(migrated.find(1)?.processing?.status).toBe("generating");
    migrated.interruptPending();
    expect(migrated.find(1)?.processing).toEqual({
      status: "failed",
      stage: "model",
      code: "interrupted",
    });
    expect(migrated.query(query()).retainedCount).toBe(1);
  });

  test("QQ 文本、纯图与图文各占一条，去重后仍记录被规则观察的事件", async () => {
    const client = new FakeQQClient();
    const log = store();
    const channel = new QQChannel(credentials, { createClient: () => client });
    const runtime = new Runtime(channel);
    cleanups.push(() => runtime.stop());
    runtime.use(qqHooks(credentials.appId, false));
    runtime.use({ onEvent: ({ event }) => log.append(event) });
    await runtime.start();
    const attachment = { content_type: "image/png", url: image.url, filename: "测试.png" };
    await client.message(qqMessage());
    await client.message({
      ...qqMessage("c2c", "image-only"),
      content: "",
      attachments: [attachment],
    });
    await client.message({
      ...qqMessage("group", "mixed"),
      content: "配图说明",
      attachments: [attachment, attachment],
    });
    await client.message({
      ...qqMessage("group", "mixed"),
      content: "配图说明",
      attachments: [attachment, attachment],
    });
    const page = log.query(query());
    expect(page.retainedCount).toBe(3);
    expect(page.messages.map((row) => row.conversationType)).toEqual(["group", "direct", "direct"]);
    expect(page.messages[0]?.content).toMatchObject({
      type: "message",
      text: "配图说明",
      images: [{ name: "测试.png" }, { name: "测试.png" }],
    });
    expect(log.query(query("contentType=image")).matchedCount).toBe(1);
    expect(log.query(query("contentType=mixed&category=group")).matchedCount).toBe(1);
    expect(log.query(query("contentType=media")).matchedCount).toBe(2);
    expect(client.sends).toHaveLength(0);
  });

  test("落盘后重新打开仍去重，ID 命名空间独立，按条数淘汰最旧记录", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hina-logs-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const path = join(folder, "private", "messages.sqlite");
    const first = new SQLiteMessageLogStore(path, 3);
    first.append(event("one"));
    first.close();
    first.close();
    const reopened = new SQLiteMessageLogStore(path, 3);
    cleanups.push(() => reopened.close());
    reopened.append(event("one"));
    reopened.append(event("one", { conversationId: "other-room" }));
    reopened.append(event("three"));
    reopened.append(event("four"));
    expect(reopened.query(query()).messages.map((row) => row.id)).toEqual(["four", "three", "one"]);
    expect(reopened.find(1)).toBeUndefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(folder, "private"))).mode & 0o777).toBe(0o700);
  });

  test("翻页快照不因新消息跳动；关键词中的 SQL、百分号和下划线作为文字处理", () => {
    const log = store();
    for (let index = 1; index <= 5; index += 1) log.append(event(String(index)));
    const first = log.query(query("pageSize=2"));
    log.append(event("six", { content: { type: "text", text: "100%_ ' OR 1=1 --" } }));
    const second = log.query(query(`pageSize=2&page=2&snapshot=${first.snapshot}`));
    expect(first.messages.map((row) => row.id)).toEqual(["5", "4"]);
    expect(second.messages.map((row) => row.id)).toEqual(["3", "2"]);
    expect(second.newCount).toBe(1);
    expect(second.matchedCount).toBe(5);
    expect(log.query(query("search=100%25_")).matchedCount).toBe(1);
    expect(log.query(query("search=' OR 1=1 --")).matchedCount).toBe(1);
    expect(log.query(query("channel=unknown")).messages).toEqual([]);
    expect(log.query(query("page=999")).page).toBe(1);
  });

  test("公共协议兼容旧文本，拒绝未知分类、危险地址与畸形分页响应", () => {
    const legacy = { ...event("legacy"), conversationType: undefined };
    expect(parseEvent(legacy).conversationType).toBeUndefined();
    expect(() => parseEvent({ ...legacy, conversationType: "secret" })).toThrow();
    for (const url of [
      "file:///tmp/private",
      "http://localhost/private",
      "https://user:pass@example.com/image",
    ]) {
      expect(() =>
        parseEvent({
          ...legacy,
          content: { type: "message", text: "", images: [{ ...image, url }] },
        }),
      ).toThrow();
    }
    expect(() => parseLogQuery(new URLSearchParams("pageSize=1000"))).toThrow();
    expect(() => parseLogQuery(new URLSearchParams("snapshot=NaN"))).toThrow();
    const response = { ...store().query(query()), connection: "online", replyEnabled: false };
    expect(parseLogResponse(response).messages).toEqual([]);
    expect(() => parseLogResponse({ ...response, connection: ["online"] })).toThrow();
  });
});

describe("本机只读服务", () => {
  test("实时通知在落盘后推送，不包含消息正文；取消与停止释放订阅", async () => {
    const log = store();
    const streams = new LogStreams(log);
    cleanups.push(() => streams.close());
    const signal = new AbortController();
    const stream = streams.open(signal.signal);
    if (!stream) throw new Error("测试流未打开");
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    log.append(
      event("stream-event", { content: { type: "text", text: "不应出现在通知中的正文" } }),
    );
    const notification = new TextDecoder().decode((await reader.read()).value);
    expect(notification).toBe("event: changed\ndata: {}\n\n");
    expect(log.query(query()).retainedCount).toBe(1);
    for (let index = 0; index < 20; index += 1) log.append(event(`burst-${index}`));
    expect((await reader.read()).done).toBe(false);
    for (let index = 0; index < 2; index += 1) {
      log.append(event(`after-burst-${index}`));
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: changed");
    }
    signal.abort();
    expect((await reader.read()).done).toBe(true);
    for (let index = 0; index < 8; index += 1)
      expect(streams.open(new AbortController().signal)).toBeDefined();
    expect(streams.open(new AbortController().signal)).toBeUndefined();
    streams.close();
    const reopened = streams.open(new AbortController().signal);
    expect(reopened).toBeDefined();
    await reopened?.cancel();
    let changes = 0;
    const unsubscribe = log.subscribe(() => {
      changes += 1;
    });
    log.append(event("stream-event"));
    expect(changes).toBe(0);
    unsubscribe();
    log.append(event("after-close"));
    expect(changes).toBe(0);
  });

  test("HTTP 查询可读取消息，拒绝跨站、伪造 Host、写入和凭据路径", async () => {
    const log = store();
    log.append(event("http-one"));
    const folder = await mkdtemp(join(tmpdir(), "hina-web-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, "index.html"), "<!doctype html><title>Hina fixture</title>");
    await writeFile(join(folder, "qqbot.json"), "private fixture");
    const server = startLogServer({
      store: log,
      assetsDirectory: folder,
      port: 0,
      connection: () => "online",
      replyEnabled: false,
    });
    cleanups.push(() => server.stop());
    const response = await fetch(`${server.url}/api/messages`);
    expect(response.status).toBe(200);
    expect(parseLogResponse(await response.json()).retainedCount).toBe(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const streamController = new AbortController();
    const updates = await fetch(`${server.url}/api/events`, { signal: streamController.signal });
    expect(updates.headers.get("content-type")).toContain("text/event-stream");
    const reader = updates.body?.getReader();
    if (!reader) throw new Error("HTTP 实时流缺失");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    log.append(event("http-two"));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: changed");
    await reader.cancel();
    streamController.abort();
    expect((await fetch(server.url)).status).toBe(200);
    for (const path of [
      "/.hina/qqbot.json",
      "/qqbot.json",
      "/assets/../qqbot.json",
      "/api/messages/1/images/0",
    ]) {
      expect((await fetch(`${server.url}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${server.url}/api/messages?page=-1`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/messages`, { method: "POST" })).status).toBe(405);
    expect(
      (await fetch(`${server.url}/api/messages`, { headers: { Origin: "https://example.com" } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(`${server.url}/api/messages`, { headers: { Host: "example.com" } })).status,
    ).toBe(403);
    expect(await readFile(join(folder, "qqbot.json"), "utf8")).toBe("private fixture");
  });
});

describe("图片读取边界", () => {
  const signal = new AbortController().signal;
  test("仅允许明确的 QQ HTTPS 图片域名，不允许重定向或任意代理地址", async () => {
    for (const url of [
      "http://multimedia.nt.qq.com.cn/a",
      "https://localhost/a",
      "https://multimedia.nt.qq.com.cn.evil.com/a",
      "https://multimedia.nt.qq.com.cn:8080/a",
    ]) {
      expect(() => validateImageUrl(url)).toThrow();
    }
    let init: RequestInit | undefined;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII=",
      "base64",
    );
    const result = await fetchImage(image.url, signal, async (_url, options) => {
      init = options;
      return new Response(png);
    });
    expect(init?.redirect).toBe("error");
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes.length).toBe(png.length);
  });

  test("拒绝超限和 SVG/HTML，取消会终止等待而不泄露远端响应", async () => {
    await expect(
      fetchImage(
        image.url,
        signal,
        async () =>
          new Response("oversize", {
            headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
          }),
      ),
    ).rejects.toThrow("8 MiB");
    await expect(
      fetchImage(image.url, signal, async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
    ).rejects.toThrow("8 MiB");
    await expect(
      fetchImage(image.url, signal, async () => new Response("<svg onload='alert(1)'/>")),
    ).rejects.toThrow("格式");
    const controller = new AbortController();
    const pending = fetchImage(image.url, controller.signal, () => new Promise(() => {}));
    controller.abort(new Error("fixture cancellation"));
    await expect(pending).rejects.toThrow("fixture cancellation");
  });
});

import { expect, test } from "bun:test";
import { abortable, operationScope } from "../src/operations";
import { QQChannel } from "../src/qq/channel";
import { createQQClient } from "../src/qq/client";
import { qqHooks } from "../src/qq/hooks";
import { Runtime } from "../src/runtime";
import { credentials, gate } from "./qq-fixture";

test("官方 QQ SDK 在 Bun 下完成 Token、网关、私聊/群聊接收和被动回复", async () => {
  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  const complete = gate<void>();
  const slowStarted = gate<void>();
  const slowResponse = gate<Response>();
  let sent = 0;
  let intents: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, instance) {
      const path = new URL(request.url).pathname;
      if (path === "/ws") {
        if (instance.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      }
      if (path === "/app/getAppAccessToken")
        return Response.json({ access_token: "fixture-access-token", expires_in: 7200 });
      if (path === "/gateway") return Response.json({ url: `ws://127.0.0.1:${instance.port}/ws` });
      if (path.startsWith("/v2/")) {
        requests.push({
          path,
          authorization: request.headers.get("Authorization"),
          body: await request.json(),
        });
        if (path === "/v2/users/slow/messages") {
          slowStarted.resolve();
          return slowResponse.promise;
        }
        return Response.json({ id: `reply-${requests.length}`, timestamp: "2026-11-03T00:00:00Z" });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }));
      },
      message(socket, data) {
        const value: unknown = JSON.parse(data.toString());
        if (typeof value !== "object" || value === null || !("op" in value)) return;
        if (value.op === 1) socket.send(JSON.stringify({ op: 11 }));
        if (value.op !== 2) return;
        if ("d" in value && typeof value.d === "object" && value.d !== null && "intents" in value.d)
          intents = value.d.intents;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "fixture-session", user: { id: "bot" } },
          }),
        );
        const c2c = {
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          s: 2,
          d: {
            id: "c2c-1",
            author: { user_openid: "fixture-user" },
            content: "/ping",
            timestamp: "2026-11-03T00:00:00Z",
          },
        };
        socket.send(JSON.stringify(c2c));
        socket.send(
          JSON.stringify({
            op: 0,
            t: "GROUP_AT_MESSAGE_CREATE",
            s: 3,
            d: {
              id: "group-1",
              group_openid: "fixture-group",
              author: { member_openid: "member" },
              content: "/ping",
              timestamp: "2026-11-03T00:00:00Z",
            },
          }),
        );
        socket.send(JSON.stringify({ ...c2c, s: 4 }));
      },
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = createQQClient(credentials, { apiBaseUrl: baseUrl, tokenBaseUrl: baseUrl });
  const channel = new QQChannel(credentials, { createClient: () => client });
  const runtime = new Runtime(channel);
  runtime.use(qqHooks(credentials.appId, true));
  runtime.use({
    afterSend: () => {
      sent += 1;
      if (sent === 2) complete.resolve();
    },
  });
  const scope = operationScope(3000);
  try {
    await abortable(() => runtime.start(), scope.signal);
    await abortable(() => complete.promise, scope.signal);
    expect(intents).toBe(1 << 25);
    expect(requests.map((request) => request.path).sort()).toEqual([
      "/v2/groups/fixture-group/messages",
      "/v2/users/fixture-user/messages",
    ]);
    for (const request of requests) {
      expect(request.authorization).toBe("QQBot fixture-access-token");
      expect(request.body).toEqual({
        content: "Hina QQ Bot 已连接。",
        msg_type: 0,
        msg_id: request.path.includes("groups") ? "group-1" : "c2c-1",
        msg_seq: 1,
      });
    }
    const cancellation = new AbortController();
    const pending = client
      .sendReply(
        { scope: "c2c", targetId: "slow", msgId: "slow-1" },
        "fixture",
        1,
        cancellation.signal,
      )
      .catch((error: unknown) => error);
    await abortable(() => slowStarted.promise, scope.signal);
    cancellation.abort();
    expect(await abortable(() => pending, scope.signal)).toBeInstanceOf(Error);
  } finally {
    slowResponse.resolve(Response.json({ id: "late-fixture-reply" }));
    scope.dispose();
    await runtime.stop();
    await server.stop(true);
  }
});

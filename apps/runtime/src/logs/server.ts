import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { type ConnectionStatus, type MessageLogQuery, parseLogQuery } from "@hina/logs";
import type { MessageLogStore } from "./store";
import { fetchImage } from "./images";
import { LogStreams } from "./stream";
import { settingsApi } from "../settings/api";
import type { EncryptedSettingsStore } from "../settings/store";

interface LogServerOptions {
  readonly store: MessageLogStore;
  readonly assetsDirectory: string;
  readonly connection: () => ConnectionStatus;
  readonly replyEnabled: boolean | (() => boolean);
  readonly settings?: EncryptedSettingsStore;
  readonly fixedReply?: boolean;
  readonly port?: number;
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function startLogServer(options: LogServerOptions) {
  const assetsRoot = resolve(options.assetsDirectory);
  const controller = new AbortController();
  const streams = new LogStreams(options.store);
  const configure = options.settings
    ? settingsApi(options.settings, controller.signal, options.fixedReply ?? false)
    : undefined;
  let activeImages = 0;
  let listeningPort = options.port ?? 3410;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 3410,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const respond = (body: BodyInit | null, status: number, type = "text/plain; charset=utf-8") =>
        new Response(body, { status, headers: { ...securityHeaders, "Content-Type": type } });
      const host = request.headers.get("host");
      const allowedHosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
      const origin = request.headers.get("origin");
      const allowedOrigins = [
        ...allowedHosts.map((value) => `http://${value}`),
        "http://127.0.0.1:5173",
      ];
      if (
        !host ||
        !allowedHosts.includes(host) ||
        (origin !== null && !allowedOrigins.includes(origin)) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return respond("仅允许本机同源访问", 403);
      try {
        if (url.pathname.startsWith("/api/llm/") && configure) {
          const response = await configure(request);
          return new Response(response.body, {
            status: response.status,
            headers: { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" },
          });
        }
        if (request.method !== "GET") return respond("仅支持读取", 405);
        if (url.pathname === "/api/events") {
          const stream = streams.open(request.signal);
          return stream
            ? respond(stream, 200, "text/event-stream; charset=utf-8")
            : respond("实时连接数量已达上限", 503);
        }
        const imageRoute = /^\/api\/messages\/([1-9]\d{0,14})\/images\/(\d)$/.exec(url.pathname);
        const entryRoute = /^\/api\/messages\/([1-9]\d{0,14})$/.exec(url.pathname);
        if (entryRoute) {
          const entry = options.store.find(Number(entryRoute[1]));
          return entry
            ? respond(JSON.stringify(entry), 200, "application/json; charset=utf-8")
            : respond("消息记录不存在", 404);
        }
        if (imageRoute) {
          const event = options.store.find(Number(imageRoute[1]));
          const image =
            event?.content.type === "message"
              ? event.content.images[Number(imageRoute[2])]
              : undefined;
          if (!image || event?.origin.channelId !== "qq") return respond("图片记录不存在", 404);
          if (activeImages >= 4) return respond("图片加载繁忙，请稍后重试", 429);
          activeImages += 1;
          try {
            const result = await fetchImage(
              image.url,
              AbortSignal.any([request.signal, controller.signal]),
            );
            return respond(result.bytes, 200, result.mediaType);
          } catch {
            return respond("图片预览失败，链接可能已过期或格式、大小不受支持", 502);
          } finally {
            activeImages -= 1;
          }
        }
        if (url.pathname === "/api/messages") {
          let query: MessageLogQuery;
          try {
            query = parseLogQuery(url.searchParams);
          } catch {
            return respond("查询参数无效", 400);
          }
          const result = {
            ...options.store.query(query),
            connection: options.connection(),
            replyEnabled:
              typeof options.replyEnabled === "function"
                ? options.replyEnabled()
                : options.replyEnabled,
          };
          return respond(JSON.stringify(result), 200, "application/json; charset=utf-8");
        }
        const path = decodeURIComponent(url.pathname);
        if (
          path !== "/" &&
          path !== "/settings" &&
          !/^\/assets\/[a-zA-Z0-9._-]+\.(js|css)$/.test(path)
        )
          return respond("未找到页面", 404);
        const file = resolve(
          assetsRoot,
          path === "/" || path === "/settings" ? "index.html" : path.slice(1),
        );
        // 固定路由与 realpath 双重约束，不能借静态服务读取本机凭据或日志库。
        const [actual, canonicalRoot] = await Promise.all([realpath(file), realpath(assetsRoot)]);
        if (!actual.startsWith(`${canonicalRoot}${sep}`)) return respond("未找到页面", 404);
        const type =
          extname(actual) === ".js"
            ? "text/javascript; charset=utf-8"
            : extname(actual) === ".css"
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8";
        return respond(await readFile(actual), 200, type);
      } catch {
        return respond(
          url.pathname.startsWith("/api/")
            ? "消息日志暂时不可用"
            : "请先运行 bun run dashboard:build 构建日志页面",
          503,
        );
      }
    },
    error() {
      return new Response("消息日志暂时不可用", { status: 503, headers: securityHeaders });
    },
  });
  listeningPort = server.port ?? 3410;
  return {
    url: `http://127.0.0.1:${listeningPort}`,
    stop: () => {
      controller.abort();
      streams.close();
      return server.stop(true);
    },
  };
}

import { access, chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { startQrConnect } from "@tencent-connect/qqbot-connector";
import QRCode from "qrcode";
import { qqCredentialsFile, qqQrFile } from "./paths";
import { parseCredentials, saveQQCredentials } from "./qq/config";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const expectedAppId = args.length === 2 && args[0] === "--app-id" ? args[1] : undefined;
  if (args.length !== 0 && (!expectedAppId || !/^\d{1,32}$/.test(expectedAppId))) {
    throw new Error("用法：qq:login [--app-id 目标机器人AppID]");
  }
  try {
    await access(qqCredentialsFile);
    throw new Error("已存在 QQ 凭据，不重复绑定或覆盖；请先检查现有配置");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(qqQrFile), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && ((await stat(dirname(qqQrFile))).mode & 0o077) !== 0) {
    throw new Error("QQ 扫码目录必须仅对当前用户开放");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let stop: (() => void) | undefined;
  let rendering = Promise.resolve();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      stop = startQrConnect(
        {
          onQrDisplayed(url) {
            rendering = rendering
              .then(async () => {
                await QRCode.toFile(qqQrFile, url, { type: "png", width: 420, margin: 4 });
                await chmod(qqQrFile, 0o600);
                console.info(`QQ 扫码图片已生成：${qqQrFile}`);
                console.info(
                  "请使用手机 QQ 扫码并确认目标机器人。凭据只保存到当前项目的 .hina/qqbot.json，不会打印或提交 Git。",
                );
              })
              .catch(() => {
                controller.abort();
              });
          },
          onQrExpired() {
            console.info("QQ 二维码已过期，等待官方刷新。");
          },
          onSuccess(values) {
            if (settled) return;
            settled = true;
            void (async () => {
              controller.signal.throwIfAborted();
              if (values.length !== 1) throw new Error("需要且仅能绑定一个机器人");
              const credentials = parseCredentials(values[0]);
              if (expectedAppId && credentials.appId !== expectedAppId)
                throw new Error("扫码选择的机器人与目标 AppID 不一致");
              await saveQQCredentials(qqCredentialsFile, credentials);
              console.info("QQ 绑定成功，凭据已按私有权限保存；可运行 bun run qq。");
            })().then(resolve, reject);
          },
          onFailure() {
            if (!settled) {
              settled = true;
              reject(new Error("QQ 扫码失败或已取消"));
            }
          },
        },
        { displayQrCodeToConsole: false, signal: controller.signal },
      );
    });
  } finally {
    stop?.();
    controller.abort();
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await rendering;
    await rm(qqQrFile, { force: true });
  }
}

await main().catch(() => {
  console.error(
    "QQ 扫码未完成；请检查网络、目标 AppID 或已有凭据。没有输出 AppSecret，也不会覆盖已有凭据。",
  );
  process.exitCode = 1;
});

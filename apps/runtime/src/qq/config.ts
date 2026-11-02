import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QQCredentials } from "./client";

export function parseCredentials(value: unknown): QQCredentials {
  if (
    typeof value !== "object" ||
    value === null ||
    !("appId" in value) ||
    !("appSecret" in value) ||
    typeof value.appId !== "string" ||
    !/^\d{1,32}$/.test(value.appId) ||
    typeof value.appSecret !== "string" ||
    !value.appSecret.trim() ||
    /[\r\n]/.test(value.appSecret)
  ) {
    throw new Error(
      "QQ 凭据缺失或格式无效；请使用 qq:login 或配置 QQBOT_APP_ID 和 QQBOT_APP_SECRET",
    );
  }
  return Object.freeze({ appId: value.appId, appSecret: value.appSecret });
}

export async function loadQQCredentials(
  env: Readonly<Record<string, string | undefined>>,
  file: string,
): Promise<QQCredentials> {
  if (env.QQBOT_APP_ID || env.QQBOT_APP_SECRET) {
    return parseCredentials({ appId: env.QQBOT_APP_ID, appSecret: env.QQBOT_APP_SECRET });
  }
  try {
    const info = await stat(file);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("凭据权限过宽");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return parseCredentials(value);
  } catch {
    throw new Error(
      "无法读取 QQ 凭据；请先运行 qq:login，或检查 .hina/qqbot.json 的内容与私有权限",
    );
  }
}

export async function saveQQCredentials(file: string, value: unknown): Promise<void> {
  const credentials = parseCredentials(value);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const directory = await stat(dirname(file));
  if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) {
    throw new Error("QQ 凭据目录必须仅对当前用户开放");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // hard link 创建最终名称，既原子提交，又不会覆盖已有凭据。
    await link(temporary, file);
  } finally {
    await unlink(temporary);
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQQCredentials, parseCredentials, saveQQCredentials } from "../src/qq/config";
import { credentials } from "./qq-fixture";

const directories: string[] = [];
async function fixtureFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hina-qq-config-"));
  directories.push(directory);
  return join(directory, "qqbot.json");
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("QQ 凭据配置", () => {
  test("私有保存、去除额外个人标识、不覆盖已有配置", async () => {
    const file = await fixtureFile();
    await saveQQCredentials(file, { ...credentials, userOpenid: "not-stored" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(credentials);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadQQCredentials({}, file)).toEqual(credentials);
    await expect(
      saveQQCredentials(file, { ...credentials, appSecret: "new-fixture" }),
    ).rejects.toThrow();
    expect(await loadQQCredentials({}, file)).toEqual(credentials);
  });

  test("环境变量完整覆盖；不混用不同来源的半套凭据", async () => {
    const file = await fixtureFile();
    await saveQQCredentials(file, credentials);
    expect(
      await loadQQCredentials({ QQBOT_APP_ID: "987", QQBOT_APP_SECRET: "fixture-env" }, file),
    ).toEqual({ appId: "987", appSecret: "fixture-env" });
    await expect(loadQQCredentials({ QQBOT_APP_ID: "987" }, file)).rejects.toThrow("凭据");
    expect(() =>
      parseCredentials({ appId: "invalid", appSecret: "fixture-sensitive-marker" }),
    ).toThrow("凭据");
  });

  test("拒绝不安全权限和损坏内容，错误不回显原始凭据", async () => {
    const file = await fixtureFile();
    await writeFile(file, "fixture-sensitive-marker", { mode: 0o600 });
    await expect(loadQQCredentials({}, file)).rejects.not.toThrow("fixture-sensitive-marker");
    if (process.platform !== "win32") {
      await writeFile(file, JSON.stringify(credentials));
      await chmod(file, 0o644);
      await expect(loadQQCredentials({}, file)).rejects.toThrow("私有权限");
    }
  });
});

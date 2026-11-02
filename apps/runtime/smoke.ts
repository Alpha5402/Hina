import { deepEqual, equal } from "node:assert/strict";
import { parseActionProposal } from "@hina/core";

const message = { id: "smoke-1", actorId: "tester", conversationId: "room", text: "你好" };
const inputs = [
  message,
  { ...message, id: "smoke-2", text: "/observe" },
  message,
  { ...message, id: "smoke-3", text: "输入流末尾" },
];
async function run(input: string, mode: "--stdin" | "--demo" = "--stdin") {
  const child = Bun.spawn({
    cmd: [process.execPath, "dist/index.js", mode],
    cwd: import.meta.dir,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const { exitCode, stdout, stderr } = await run(
  `${inputs.map((input) => JSON.stringify(input)).join("\n")}\n`,
);
equal(exitCode, 0, `构建产物启动失败：${stderr}`);
const outputs = stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const value: unknown = JSON.parse(line);
    return parseActionProposal(value);
  });
deepEqual(outputs, [
  {
    type: "message.send",
    target: { channelId: "mock", accountId: "local", conversationId: "room" },
    content: { type: "text", text: "回声：你好" },
  },
  {
    type: "message.send",
    target: { channelId: "mock", accountId: "local", conversationId: "room" },
    content: { type: "text", text: "回声：输入流末尾" },
  },
]);
const demo = await run("", "--demo");
equal(demo.exitCode, 0, demo.stderr);
equal(demo.stdout.trim().split("\n").length, 2);
equal(demo.stderr.includes("输入 4，输出 2，观察 1，去重 1"), true);

const invalid = await run("invalid-sensitive-marker\n");
equal(invalid.exitCode, 1);
equal(invalid.stdout, "");
equal(invalid.stderr.includes("invalid-sensitive-marker"), false);
console.info("Mock 通路烟测通过：JSONL 输入输出、观察、去重、演示模式及错误退出均符合预期。");

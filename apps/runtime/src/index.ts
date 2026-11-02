import { createInterface, type Interface } from "node:readline";
import type { EventResult } from "@hina/core";
import { MockChannel } from "./channels/mock-channel";
import { demoHooks } from "./demo-hooks";
import { Runtime } from "./runtime";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--stdin" && args[0] !== "--demo")) {
    throw new Error("用法：bun run start [--demo|--stdin]");
  }
  const channel = new MockChannel({
    output: (action) => {
      console.info(JSON.stringify(action));
    },
  });
  const runtime = new Runtime(channel);
  const unregister = runtime.use(demoHooks());
  let reader: Interface | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    reader?.close();
    void runtime.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runtime.start();
    if (args[0] === "--stdin") {
      reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of reader) {
        if (!line.trim()) continue;
        try {
          const input: unknown = JSON.parse(line);
          await channel.receive(input);
        } catch {
          if (interrupted) break;
          console.error("Mock 输入或处理失败；请检查 JSON 字段、Hook 与运行状态。");
          process.exitCode = 1;
        }
      }
    } else {
      const first = {
        id: "demo-1",
        actorId: "tester",
        conversationId: "room-1",
        text: "你好，Hina",
      };
      const inputs = [
        first,
        { ...first, id: "demo-2", text: "/observe" },
        first,
        { ...first, id: "demo-3", conversationId: "room-2", text: "另一个会话" },
      ];
      const results: EventResult[] = [];
      for (const input of inputs) results.push(await channel.receive(input));
      console.error(
        `Mock 演示完成：输入 ${inputs.length}，输出 ${channel.outputs.length}，观察 ${results.filter((result) => result.status === "observed").length}，去重 ${results.filter((result) => result.status === "duplicate").length}。`,
      );
    }
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    reader?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    unregister();
    await runtime.stop();
  }
}

await main().catch(() => {
  console.error("Runtime 运行失败，请检查启动参数、Channel 与 Hook 配置。");
  process.exitCode = 1;
});

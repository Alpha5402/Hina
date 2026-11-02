import { abortable } from "./operations";

export async function readLimitedJson(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!body) throw new TypeError("JSON 数据缺失");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await abortable(() => reader.read(), signal);
      if (result.done) break;
      size += result.value.length;
      if (size > maxBytes) throw new TypeError("JSON 数据超出大小限制");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

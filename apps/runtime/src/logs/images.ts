import { abortable } from "../operations";

const imageHosts = new Set([
  "multimedia.nt.qq.com.cn",
  "grouppro.grouppro.qq.com",
  "c2cpicdw.qpic.cn",
  "gchat.qpic.cn",
]);
const maxImageBytes = 8 * 1024 * 1024;

export function validateImageUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !imageHosts.has(url.hostname)
  )
    throw new Error("图片来源暂不支持");
  return url;
}

function imageType(bytes: Uint8Array): string {
  const at = (index: number) => bytes[index];
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.subarray(start, end));
  if (
    at(0) === 0x89 &&
    ascii(1, 4) === "PNG" &&
    at(4) === 13 &&
    at(5) === 10 &&
    at(6) === 26 &&
    at(7) === 10
  )
    return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  throw new Error("图片格式暂不支持");
}

/** 只下载已保存事件引用的 QQ 图片；不接受任意代理地址，不跟随重定向。 */
export async function fetchImage(
  input: string,
  parent: AbortSignal,
  request: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const url = validateImageUrl(input);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
  const response = await abortable(
    () =>
      request(url, {
        signal,
        redirect: "error",
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif" },
      }),
    signal,
  );
  const declaredSize = response.headers.get("content-length");
  if (
    response.status !== 200 ||
    !response.body ||
    (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > maxImageBytes))
  ) {
    await response.body?.cancel();
    throw new Error("图片下载失败或超过 8 MiB");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      length += value.length;
      if (length > maxImageBytes) throw new Error("图片超过 8 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, mediaType: imageType(bytes) };
}

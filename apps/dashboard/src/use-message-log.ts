import { type MessageLogResponse, parseLogResponse } from "@hina/logs";
import { onMounted, onUnmounted, ref, shallowRef, watch } from "vue";

export function useMessageLog() {
  const data = shallowRef<MessageLogResponse>();
  const search = ref("");
  const channel = ref("");
  const category = ref("all");
  const contentType = ref("all");
  const pageSize = ref(50);
  const page = ref(1);
  const live = ref(true);
  const loading = ref(false);
  const error = ref("");
  let snapshot: number | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let streamTimeout: ReturnType<typeof setTimeout> | undefined;
  let source: EventSource | undefined;
  let pendingUpdate = false;
  let disposed = false;

  async function load(reset = false, quiet = false): Promise<void> {
    if (quiet && (loading.value || debounce)) {
      pendingUpdate = true;
      return;
    }
    controller?.abort();
    const current = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller?.signal === signal && controller.abort(), 5000);
    if (reset) {
      snapshot = undefined;
      page.value = 1;
    }
    loading.value = true;
    const params = new URLSearchParams({
      search: search.value,
      channel: channel.value,
      category: category.value,
      contentType: contentType.value,
      page: String(page.value),
      pageSize: String(pageSize.value),
    });
    // 实时首页始终读取最新状态；用户翻到历史页后保留快照。
    if (snapshot !== undefined && (page.value > 1 || !live.value))
      params.set("snapshot", String(snapshot));
    try {
      const response = await fetch(`/api/messages?${params}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const result = parseLogResponse(await response.json());
      if (current !== generation || disposed) return;
      data.value = result;
      snapshot = result.snapshot;
      page.value = result.page;
      error.value = "";
    } catch {
      if (current === generation && !disposed) error.value = "日志连接中断，正在重连";
    } finally {
      clearTimeout(timeout);
      if (current === generation && !disposed) {
        loading.value = false;
        if (pendingUpdate && live.value) {
          pendingUpdate = false;
          void load(false, true);
        }
      }
    }
  }

  function refresh(): void {
    clearTimeout(debounce);
    debounce = undefined;
    void load(true);
  }

  function stopUpdates(): void {
    source?.close();
    source = undefined;
    clearTimeout(streamTimeout);
    clearInterval(fallback);
    fallback = undefined;
    pendingUpdate = false;
  }

  function startUpdates(): void {
    stopUpdates();
    if (!live.value || document.visibilityState !== "visible" || disposed) return;
    const events = new EventSource("/api/events");
    source = events;
    const update = () => {
      void load(false, true);
    };
    const poll = () => {
      if (source !== events) return;
      events.close();
      source = undefined;
      clearTimeout(streamTimeout);
      // SSE 不可用时维持自动更新，不要求用户手动刷新。
      fallback = setInterval(update, 1000);
    };
    streamTimeout = setTimeout(poll, 5000);
    events.onopen = () => clearTimeout(streamTimeout);
    events.addEventListener("ready", update);
    events.addEventListener("changed", update);
    events.addEventListener("status", update);
    events.onerror = poll;
  }

  function turnPage(next: number): void {
    if (loading.value || !data.value || next < 1 || next > data.value.pageCount) return;
    page.value = next;
    void load();
  }

  function visibilityChanged(): void {
    if (document.visibilityState === "hidden") stopUpdates();
    else {
      if (live.value) void load(false, true);
      startUpdates();
    }
  }

  watch([search, channel, category, contentType, pageSize], () => {
    controller?.abort();
    generation += 1;
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 200);
  });
  watch(live, (enabled) => {
    stopUpdates();
    // 暂停时取消在途读取，避免迟到响应继续插入消息。
    controller?.abort();
    generation += 1;
    loading.value = false;
    if (enabled) {
      refresh();
      startUpdates();
    }
  });
  onMounted(() => {
    refresh();
    startUpdates();
    document.addEventListener("visibilitychange", visibilityChanged);
  });
  onUnmounted(() => {
    disposed = true;
    generation += 1;
    controller?.abort();
    clearTimeout(debounce);
    stopUpdates();
    document.removeEventListener("visibilitychange", visibilityChanged);
  });
  return {
    data,
    search,
    channel,
    category,
    contentType,
    pageSize,
    page,
    live,
    loading,
    error,
    refresh,
    turnPage,
  };
}

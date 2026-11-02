import { type MessageLogEntry, parseMessageLogEntry } from "@hina/logs";
import { onMounted, onUnmounted, shallowRef, watch } from "vue";

export function useMessageDetail(source: () => MessageLogEntry) {
  const entry = shallowRef(source());
  let polling: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  let pending = false;
  const update = (next: MessageLogEntry) => {
    if (
      next.sequence === entry.value.sequence &&
      (next.processingVersion ?? 0) >= (entry.value.processingVersion ?? 0)
    )
      entry.value = next;
  };
  watch(source, update);
  onMounted(() => {
    polling = setInterval(async () => {
      if (
        pending ||
        disposed ||
        document.visibilityState !== "visible" ||
        !entry.value.processing ||
        !["generating", "generated", "sending"].includes(entry.value.processing.status)
      )
        return;
      pending = true;
      controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => {
        if (controller?.signal === signal) controller.abort();
      }, 5000);
      try {
        const response = await fetch(`/api/messages/${entry.value.sequence}`, {
          signal,
          cache: "no-store",
        });
        if (response.ok && !disposed) update(parseMessageLogEntry(await response.json()));
      } catch {
        /* 保留最后状态，下一次有界查询继续确认。 */
      } finally {
        clearTimeout(timer);
        pending = false;
      }
    }, 1000);
  });
  onUnmounted(() => {
    disposed = true;
    clearInterval(polling);
    controller?.abort();
  });
  return entry;
}

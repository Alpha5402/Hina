<script setup lang="ts">
import type { MessageLogEntry } from "@hina/logs";
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Pause,
  Play,
  Search,
  Settings2,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import LogSelect from "./LogSelect.vue";
import MessageDetail from "./MessageDetail.vue";
import { messageText } from "./message-display";
import { useMessageLog } from "./use-message-log";
import ThemeButton from "./ThemeButton.vue";
import { processingLabel } from "./processing-display";

const {
  data,
  search,
  channel,
  category,
  contentType,
  pageSize,
  live,
  loading,
  error,
  refresh,
  turnPage,
} = useMessageLog();
const selected = shallowRef<MessageLogEntry>();
const viewport = ref<HTMLElement>();
const categories: Record<string, string> = {
  direct: "私聊",
  group: "群聊",
  channel: "频道",
  unknown: "未分类",
};
const sourceLabel = (value: string) => (value === "qq" ? "QQ" : value === "mock" ? "Mock" : value);
const sourceOptions = computed(() => [
  { value: "", label: "全部来源" },
  ...(data.value?.channels ?? []).map((value) => ({ value, label: sourceLabel(value) })),
]);
const conversationOptions = [
  { value: "all", label: "全部会话" },
  { value: "direct", label: "私聊" },
  { value: "group", label: "群聊" },
];
const contentOptions = [
  { value: "all", label: "全部类型" },
  { value: "text", label: "文本" },
  { value: "media", label: "图片" },
];
const sizeOptions = [
  { value: 25, label: "25 条 / 页" },
  { value: 50, label: "50 条 / 页" },
  { value: 100, label: "100 条 / 页" },
];
const filtered = computed(() =>
  Boolean(search.value || channel.value || category.value !== "all" || contentType.value !== "all"),
);
const historical = computed(() => (data.value?.page ?? 1) > 1);
const connection = computed(() =>
  error.value ? "error" : (data.value?.connection ?? "connecting"),
);
const connectionLabel = computed(() =>
  error.value
    ? "连接中断"
    : data.value?.connection === "online"
      ? "QQ 在线"
      : data.value?.connection === "offline"
        ? "QQ 离线"
        : "连接中",
);
const shortId = (value: string) =>
  value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
const time = (value: string) => {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
};
function clearFilters() {
  search.value = "";
  channel.value = "";
  category.value = "all";
  contentType.value = "all";
}

watch(
  () => data.value?.messages,
  async (messages) => {
    const updated = messages?.find((message) => message.sequence === selected.value?.sequence);
    if (updated) selected.value = updated;
    const element = viewport.value;
    if (!element) return;
    const atTop = element.scrollTop < 4;
    const edge = element.getBoundingClientRect().top + 40;
    const anchor = [...element.querySelectorAll<HTMLTableRowElement>("tr[data-sequence]")].find(
      (row) => row.getBoundingClientRect().bottom > edge,
    );
    const sequence = anchor?.dataset.sequence;
    const offset = anchor?.getBoundingClientRect().top;
    await nextTick();
    if (atTop) element.scrollTop = 0;
    else if (sequence && offset !== undefined) {
      const next = element.querySelector(`[data-sequence="${sequence}"]`);
      if (next) element.scrollTop += next.getBoundingClientRect().top - offset;
    }
  },
);
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="page-title">
        <span class="brand">Hina</span>
        <h1>消息日志</h1>
      </div>
      <div class="header-actions">
        <span class="connection" :data-state="connection"
          ><span class="status-dot" aria-hidden="true"></span>{{ connectionLabel }}</span
        >
        <button
          class="live-button"
          :class="{ enabled: live && !historical }"
          type="button"
          :aria-pressed="live"
          :aria-label="live ? '暂停实时更新' : '恢复实时更新'"
          @click="live = !live"
        >
          <Pause v-if="live" :size="16" aria-hidden="true" />
          <Play v-else :size="16" aria-hidden="true" />
          {{ historical ? "历史记录" : live ? "实时" : "已暂停" }}
        </button>
        <a class="icon-button" href="/settings" aria-label="设置"
          ><Settings2 :size="18" aria-hidden="true" /><span class="sr-only">设置</span></a
        >
        <ThemeButton />
      </div>
    </header>
    <main>
      <div class="toolbar">
        <div class="search-field">
          <Search :size="16" aria-hidden="true" />
          <input
            v-model="search"
            type="search"
            aria-label="搜索消息"
            placeholder="搜索消息"
            maxlength="200"
            autocomplete="off"
          ><button
            v-if="search"
            class="search-clear"
            type="button"
            aria-label="清空搜索"
            @click="search = ''"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </div>
        <div class="filter-controls">
          <LogSelect
            v-if="sourceOptions.length > 2"
            v-model="channel"
            label="来源"
            :options="sourceOptions"
          />
          <LogSelect v-model="category" label="会话分类" :options="conversationOptions" />
          <LogSelect v-model="contentType" label="内容类型" :options="contentOptions" />
          <button
            v-if="filtered"
            class="text-button clear-filters"
            type="button"
            @click="clearFilters"
          >
            清除
          </button>
        </div>
        <button v-if="historical" class="text-button latest-button" type="button" @click="refresh">
          回到最新
        </button>
      </div>
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span
        ><button class="text-button" type="button" @click="refresh">重试</button>
      </div>
      <!-- biome-ignore-start lint/a11y/noNoninteractiveTabindex: 可滚动的命名区域需要键盘焦点。 -->
      <section
        ref="viewport"
        class="table-viewport"
        tabindex="0"
        aria-label="消息列表"
        :aria-busy="loading && !data"
      >
        <table>
          <caption class="sr-only">
            收到的消息，按接收顺序倒序
          </caption>
          <colgroup>
            <col class="col-sequence">
            <col class="col-time">
            <col class="col-source">
            <col class="col-category">
            <col class="col-sender">
            <col>
            <col class="col-processing">
            <col class="col-detail">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">时间</th>
              <th scope="col">来源</th>
              <th scope="col">会话</th>
              <th scope="col">发送者</th>
              <th scope="col">内容</th>
              <th scope="col">状态</th>
              <th scope="col"><span class="sr-only">详情</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="message in data?.messages ?? []"
              :key="message.sequence"
              :data-sequence="message.sequence"
              :class="{ selected: selected?.sequence === message.sequence }"
            >
              <td class="sequence">{{ message.sequence }}</td>
              <td class="timestamp">
                <time :datetime="message.receivedAt">{{ time(message.receivedAt) }}</time>
              </td>
              <td>{{ sourceLabel(message.origin.channelId) }}</td>
              <td class="conversation">{{ categories[message.conversationType ?? "unknown"] }}</td>
              <td class="sender">{{ shortId(message.actorId) }}</td>
              <td>
                <button
                  class="message-open"
                  type="button"
                  :aria-label="`查看第 ${message.sequence} 条消息`"
                  @click="selected = message"
                >
                  <span v-if="messageText(message)" class="message-preview">{{
                    messageText(message)
                  }}</span><span v-if="message.content.type === 'message'" class="media-summary"
                    ><ImageIcon :size="16" aria-hidden="true" />{{ message.content.images.length }}
                    张图片</span
                  >
                </button>
              </td>
              <td>
                <span
                  class="processing-state"
                  :data-state="message.processing?.status ?? 'received'"
                  >{{
                    processingLabel(message)
                  }}</span
                >
              </td>
              <td>
                <button
                  class="icon-button row-detail"
                  type="button"
                  :aria-label="`打开第 ${message.sequence} 条消息详情`"
                  @click="selected = message"
                >
                  <ChevronRight :size="16" aria-hidden="true" />
                </button>
              </td>
            </tr>
            <tr v-if="!data?.messages.length">
              <td colspan="8" class="empty-state">
                {{
                  loading && !data
                    ? "正在加载…"
                    : error && !data
                      ? "暂时无法连接"
                      : filtered
                        ? "没有匹配的消息"
                        : "暂无消息"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <!-- biome-ignore-end lint/a11y/noNoninteractiveTabindex: 消息列表结束。 -->
      <footer class="table-footer">
        <span class="message-count">{{ data?.matchedCount.toLocaleString() ?? "—" }} 条</span>
        <nav class="pagination" aria-label="消息分页">
          <LogSelect v-model="pageSize" label="每页条数" :options="sizeOptions" />
          <button
            class="icon-button"
            type="button"
            aria-label="上一页"
            :disabled="loading || !data || data.page <= 1"
            @click="turnPage((data?.page ?? 1) - 1)"
          >
            <ChevronLeft :size="18" aria-hidden="true" />
          </button><span class="page-number"
            >{{ data?.page ?? 1 }}
            / {{ data?.pageCount ?? 1 }}</span
          ><button
            class="icon-button"
            type="button"
            aria-label="下一页"
            :disabled="loading || !data || data.page >= data.pageCount"
            @click="turnPage((data?.page ?? 1) + 1)"
          >
            <ChevronRight :size="18" aria-hidden="true" />
          </button>
        </nav>
      </footer>
    </main>
    <MessageDetail v-if="selected" :message="selected" @close="selected = undefined" />
  </div>
</template>

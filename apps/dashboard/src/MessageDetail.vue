<script setup lang="ts">
import type { MessageLogEntry } from "@hina/logs";
import { ChevronDown, X } from "@lucide/vue";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import ImagePreview from "./ImagePreview.vue";
import { contentLabel, messageText } from "./message-display";
import { useMessageDetail } from "./use-message-detail";
import { processingError, processingLabel } from "./processing-display";

const props = defineProps<{ message: MessageLogEntry }>();
const emit = defineEmits<{ close: [] }>();
const detail = useMessageDetail(() => props.message);
const modelResponse = computed(() => {
  const current = detail.value.processing;
  return current && "response" in current ? current.response : undefined;
});
const apiState = computed(() =>
  !detail.value.processing || detail.value.processing.status === "skipped"
    ? "未调用"
    : detail.value.processing.status === "generating"
      ? "请求中"
      : modelResponse.value
        ? "已返回"
        : "失败",
);
const outputState = computed(() =>
  detail.value.processing?.status === "sent"
    ? "已发送"
    : detail.value.processing?.status === "sending"
      ? "发送中"
      : detail.value.processing?.status === "blocked"
        ? "已拦截"
        : detail.value.processing?.status === "failed" && detail.value.processing.stage === "send"
          ? "未确认"
          : "未发送",
);
const panel = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
const raw = ref(false);
let previousFocus: Element | null = null;
let root: HTMLElement | null = null;
let previousInert = false;
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
function keyboard(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
  if (event.key !== "Tab") return;
  const items = panel.value?.querySelectorAll<HTMLElement>(
    "button:not(:disabled), a[href], input, [tabindex='0']",
  );
  const first = items?.[0];
  const last = items?.[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
onMounted(async () => {
  previousFocus = document.activeElement;
  root = document.getElementById("app");
  previousInert = root?.inert ?? false;
  if (root) root.inert = true;
  document.addEventListener("keydown", keyboard);
  await nextTick();
  closeButton.value?.focus();
});
onUnmounted(() => {
  document.removeEventListener("keydown", keyboard);
  if (root) root.inert = previousInert;
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  else root?.querySelector<HTMLElement>(".table-viewport")?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="detail-layer">
      <button
        class="detail-backdrop"
        type="button"
        tabindex="-1"
        aria-label="关闭消息详情"
        @click="emit('close')"
      ></button>
      <section
        ref="panel"
        class="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-heading"
      >
        <header class="detail-header">
          <h2 id="detail-heading">
            消息 #{{ detail.sequence }}<span>{{ contentLabel(detail) }}</span>
          </h2>
          <button
            ref="closeButton"
            class="icon-button"
            type="button"
            aria-label="关闭消息详情"
            @click="emit('close')"
          >
            <X :size="18" aria-hidden="true" />
          </button>
        </header>
        <div class="detail-body">
          <h3 v-if="detail.processing" class="detail-section-title">输入</h3>
          <p v-if="messageText(detail)" class="full-message">
            {{ messageText(detail) }}
          </p>
          <div v-if="detail.content.type === 'message'" class="image-grid">
            <ImagePreview
              v-for="(image, index) in detail.content.images"
              :key="index"
              :sequence="detail.sequence"
              :index="index"
              v-bind="image.name === undefined ? {} : { name: image.name }"
            />
          </div>
          <section v-if="detail.processing" class="processing-detail" aria-label="处理链路">
            <ol class="processing-steps">
              <li><span>输入</span><span>已接收</span></li>
              <li><span>API</span><span>{{ apiState }}</span></li>
              <li><span>输出</span><span>{{ outputState }}</span></li>
            </ol>
            <p v-if="detail.processing.status === 'skipped'" class="processing-note">
              {{ processingLabel(detail) }}
            </p>
            <p v-if="detail.processing.status === 'blocked'" class="processing-note">
              配置或策略已变更，回复未发送
            </p>
            <p v-if="processingError(detail)" class="processing-error" role="status">
              {{ processingError(detail) }}
            </p>
            <div v-if="modelResponse" class="model-response">
              <h3 class="detail-section-title">API 响应</h3>
              <p class="model-response-text">{{ modelResponse.text }}</p>
              <p class="model-metrics">
                {{ modelResponse.model }} · {{ modelResponse.durationMs }} ms<span
                  v-if="modelResponse.usage"
                >
                  · {{ modelResponse.usage.totalTokens }} Token</span
                >
              </p>
              <p v-if="modelResponse.finishReason === 'length'" class="processing-note">
                达到输出 Token 上限
              </p>
            </div>
            <p v-if="detail.processing.status === 'sent'" class="delivery-confirmation">
              已回复至当前会话 · {{ time(detail.processing.sentAt) }}
            </p>
          </section>
          <dl class="message-metadata">
            <div>
              <dt>来源</dt>
              <dd>
                {{ detail.origin.channelId === "qq" ? "QQ" : detail.origin.channelId }} ·
                {{
                  detail.conversationType === "direct"
                    ? "私聊"
                    : detail.conversationType === "group"
                      ? "群聊"
                      : "未分类"
                }}
              </dd>
            </div>
            <div>
              <dt>发送者</dt>
              <dd>{{ detail.actorId }}</dd>
            </div>
            <div>
              <dt>会话</dt>
              <dd>{{ detail.conversationId }}</dd>
            </div>
            <div>
              <dt>账号</dt>
              <dd>{{ detail.origin.accountId }}</dd>
            </div>
            <div>
              <dt>事件 ID</dt>
              <dd>{{ detail.id }}</dd>
            </div>
            <div>
              <dt>发送时间</dt>
              <dd>{{ time(detail.timestamp) }}</dd>
            </div>
            <div>
              <dt>接收时间</dt>
              <dd>{{ time(detail.receivedAt) }}</dd>
            </div>
          </dl>
          <div v-if="messageText(detail) !== detail.content.text" class="raw-message">
            <button
              class="text-button"
              type="button"
              :aria-expanded="raw"
              aria-controls="raw-text"
              @click="raw = !raw"
            >
              原始文本<ChevronDown :size="16" aria-hidden="true" />
            </button>
            <pre v-if="raw" id="raw-text">{{ detail.content.text }}</pre>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

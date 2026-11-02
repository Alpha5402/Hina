<script setup lang="ts">
import { type ModelResponse, parseModelResponse } from "@hina/logs";
import {
  defaultLlmSettings,
  type LlmSettingsUpdate,
  object,
  parseLlmSettings,
  parsePublicSettings,
  parseSettingsUpdate,
} from "@hina/settings";
import { ArrowLeft, ChevronDown } from "@lucide/vue";
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import LogSelect from "./LogSelect.vue";
import SettingSwitch from "./SettingSwitch.vue";
import ThemeButton from "./ThemeButton.vue";

const form = reactive({ ...defaultLlmSettings });
const token = ref("");
const hasToken = ref(false);
const revision = ref(0);
const loaded = ref(false);
const busy = ref<"load" | "save" | "test">();
const error = ref("");
const feedback = ref("");
const advanced = ref(false);
const result = shallowRef<ModelResponse>();
let csrf = "";
const original = ref("");
let controller: AbortController | undefined;
let disposed = false;
const dirty = computed(() => token.value.length > 0 || JSON.stringify(form) !== original.value);
const scopeOptions = [
  { value: "direct", label: "仅私聊" },
  { value: "direct-and-mentions", label: "私聊及群内 @" },
] as const;
const tokenOptions = [
  { value: "max_tokens", label: "max_tokens" },
  { value: "max_completion_tokens", label: "max_completion_tokens" },
] as const;

function apply(input: unknown) {
  const value = parsePublicSettings(input);
  Object.assign(form, parseLlmSettings(value, true));
  hasToken.value = value.hasToken;
  revision.value = value.revision;
  original.value = JSON.stringify(form);
}

async function request(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => {
    if (controller?.signal === signal) controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal, cache: "no-store" });
    const body = object(await response.json());
    if (!response.ok) {
      const detail = object(body.error);
      throw new Error(
        typeof detail.message === "string" && detail.message.length < 300
          ? detail.message
          : "请求失败",
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function load() {
  busy.value = "load";
  error.value = "";
  token.value = "";
  feedback.value = "";
  result.value = undefined;
  try {
    const body = await request("/api/llm/settings", {}, 20_000);
    if (disposed) return;
    if (typeof body.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken))
      throw new Error("配置会话无效");
    csrf = body.csrfToken;
    apply(body.settings);
    loaded.value = true;
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : "无法读取设置";
  } finally {
    if (!disposed) busy.value = undefined;
  }
}

async function submit(kind: "save" | "test") {
  if (!loaded.value || busy.value) return;
  error.value = "";
  feedback.value = "";
  result.value = undefined;
  let update: LlmSettingsUpdate;
  try {
    update = parseSettingsUpdate({
      ...form,
      expectedRevision: revision.value,
      ...(token.value.trim() ? { token: token.value.trim() } : {}),
    });
  } catch {
    error.value = "请检查 API 地址、模型名称和请求限制";
    return;
  }
  busy.value = kind;
  const body = JSON.stringify(update);
  if (kind === "save") token.value = "";
  try {
    const value = await request(
      kind === "save" ? "/api/llm/settings" : "/api/llm/test",
      {
        method: kind === "save" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "X-Hina-CSRF": csrf },
        body,
      },
      kind === "save" ? 20_000 : form.timeoutMs + 5000,
    );
    if (disposed) return;
    if (kind === "save") {
      apply(value.settings);
      feedback.value = "已保存";
    } else {
      result.value = parseModelResponse(value.response);
      feedback.value = "连接成功";
    }
  } catch (cause) {
    if (!disposed)
      error.value =
        cause instanceof Error && cause.name !== "AbortError" ? cause.message : "请求已取消或超时";
  } finally {
    if (!disposed) busy.value = undefined;
  }
}

watch(
  [() => JSON.stringify(form), token],
  () => {
    feedback.value = "";
    result.value = undefined;
  },
  { flush: "sync" },
);
onMounted(load);
onUnmounted(() => {
  disposed = true;
  controller?.abort();
  token.value = "";
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="page-title">
        <span class="brand">Hina</span>
        <h1>设置</h1>
      </div>
      <div class="header-actions">
        <a class="settings-back" href="/"><ArrowLeft :size="16" aria-hidden="true" />消息日志</a>
        <ThemeButton />
      </div>
    </header>
    <main class="settings-main">
      <form class="settings-form" novalidate @submit.prevent="submit('save')">
        <div v-if="!loaded" class="settings-load">
          <span>{{ busy === "load" ? "正在读取设置…" : "设置暂不可用" }}</span
          ><button v-if="!busy" class="text-button" type="button" @click="load">重试</button>
        </div>
        <fieldset :disabled="!loaded || Boolean(busy)">
          <section class="settings-section" aria-labelledby="connection-heading">
            <h2 id="connection-heading">模型连接</h2>
            <div class="form-row">
              <label for="llm-endpoint">API 地址</label>
              <div class="field-stack">
                <input
                  id="llm-endpoint"
                  v-model="form.endpoint"
                  class="setting-input"
                  type="url"
                  placeholder="https://api.example.com/v1"
                  maxlength="2048"
                  autocomplete="off"
                  spellcheck="false"
                >
                <p class="field-hint">支持 Base URL 或完整 Chat Completions 地址</p>
              </div>
            </div>
            <div class="form-row">
              <label for="llm-model">模型</label>
              <input
                id="llm-model"
                v-model="form.model"
                class="setting-input"
                type="text"
                placeholder="模型名称"
                maxlength="128"
                autocomplete="off"
                spellcheck="false"
              >
            </div>
            <div class="form-row">
              <label for="llm-token">Secret Token</label>
              <div class="field-stack">
                <input
                  id="llm-token"
                  v-model="token"
                  class="setting-input"
                  type="password"
                  :placeholder="hasToken ? '已设置，留空保留' : '输入 Token'"
                  maxlength="4096"
                  autocomplete="off"
                  spellcheck="false"
                >
                <p class="field-hint">加密保存在本机，保存后不回显；更换 API 地址需重新输入</p>
              </div>
            </div>
          </section>
          <section class="settings-section" aria-labelledby="reply-heading">
            <h2 id="reply-heading">回复</h2>
            <div class="switch-row">
              <div>
                <span class="field-label">模型回复</span>
                <p class="field-hint">开启后，新消息及本轮上下文会发送到所配 API，并自动回复</p>
              </div>
              <SettingSwitch v-model="form.enabled" label="模型回复" />
            </div>
            <div class="form-row">
              <span class="field-label">回复范围</span>
              <LogSelect v-model="form.replyScope" label="回复范围" :options="scopeOptions" />
            </div>
            <div class="switch-row">
              <div>
                <span class="field-label">图片输入</span>
                <p class="field-hint">模型需支持图片；每条最多发送 2 张</p>
              </div>
              <SettingSwitch v-model="form.includeImages" label="图片输入" />
            </div>
          </section>
          <section class="settings-section">
            <button
              class="advanced-toggle"
              type="button"
              :aria-expanded="advanced"
              aria-controls="advanced-settings"
              @click="advanced = !advanced"
            >
              请求设置<ChevronDown :size="16" aria-hidden="true" />
            </button>
            <div v-if="advanced" id="advanced-settings" class="advanced-fields">
              <div class="form-row">
                <label for="llm-limit">最大输出 Token</label>
                <input
                  id="llm-limit"
                  v-model.number="form.maxOutputTokens"
                  class="setting-input number-input"
                  type="number"
                  min="64"
                  max="4096"
                >
              </div>
              <div class="form-row">
                <label for="llm-timeout">超时（毫秒）</label>
                <input
                  id="llm-timeout"
                  v-model.number="form.timeoutMs"
                  class="setting-input number-input"
                  type="number"
                  min="1000"
                  max="30000"
                  step="1000"
                >
              </div>
              <div class="form-row">
                <span class="field-label">Token 限制参数</span>
                <LogSelect
                  v-model="form.tokenParameter"
                  label="Token 限制参数"
                  :options="tokenOptions"
                />
              </div>
              <div class="form-row">
                <label for="llm-prompt">回复提示</label
                ><textarea
                  id="llm-prompt"
                  v-model="form.systemPrompt"
                  class="setting-input setting-textarea"
                  rows="4"
                  maxlength="8000"
                ></textarea>
              </div>
            </div>
          </section>
        </fieldset>
        <div class="settings-actions">
          <button
            class="primary-button"
            type="submit"
            :disabled="!loaded || Boolean(busy) || !dirty"
          >
            {{ busy === "save" ? "保存中…" : "保存" }}
          </button><button
            class="secondary-button"
            type="button"
            :disabled="!loaded || Boolean(busy)"
            @click="submit('test')"
          >
            {{ busy === "test" ? "测试中…" : "测试连接" }}
          </button><span class="settings-feedback" role="status">{{ feedback }}</span>
        </div>
        <p v-if="error" class="settings-error" role="alert">
          {{ error }}
          <button v-if="loaded && !busy" class="text-button" type="button" @click="load">
            重新读取
          </button>
        </p>
        <div v-if="result" class="test-result">
          <span
            >{{ result.model }}
            · {{ result.durationMs }} ms<span v-if="result.usage">
              · {{ result.usage.totalTokens }} Token</span
            ></span
          >
          <p>{{ result.text }}</p>
        </div>
      </form>
    </main>
  </div>
</template>

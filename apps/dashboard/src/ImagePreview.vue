<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ sequence: number; index: number; name?: string }>();
const state = ref<"loading" | "ready" | "error">("loading");
const attempt = ref(0);
function retry() {
  state.value = "loading";
  attempt.value += 1;
}
</script>

<template>
  <figure class="image-preview">
    <div class="image-frame" :aria-busy="state === 'loading'">
      <img
        :class="{ 'image-pending': state !== 'ready' }"
        :key="attempt"
        :src="`/api/messages/${props.sequence}/images/${props.index}?attempt=${attempt}`"
        :alt="props.name || `消息图片 ${props.index + 1}`"
        loading="lazy"
        decoding="async"
        @load="state = 'ready'"
        @error="state = 'error'"
      >
      <p v-if="state === 'loading'" class="image-placeholder" role="status">正在加载图片…</p>
      <div v-if="state === 'error'" class="image-placeholder">
        <p>图片加载失败</p>
        <button class="text-button" type="button" @click="retry">重试</button>
      </div>
    </div>
  </figure>
</template>

<script setup lang="ts">
import { Moon, Sun } from "@lucide/vue";
import { ref } from "vue";
const dark = ref(document.documentElement.dataset.theme === "dark");
function toggle() {
  dark.value = !dark.value;
  const theme = dark.value ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("hina-theme", theme);
  } catch {
    /* 主题切换不依赖存储。 */
  }
}
</script>
<template
  ><button
    class="icon-button"
    type="button"
    :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
    @click="toggle"
  >
    <Sun v-if="dark" :size="18" aria-hidden="true" /><Moon v-else :size="18" aria-hidden="true" />
  </button></template
>

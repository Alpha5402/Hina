<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; label: string }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>
<template
  ><button
    class="setting-switch"
    type="button"
    role="switch"
    :aria-label="props.label"
    :aria-checked="props.modelValue"
    @click="emit('update:modelValue', !props.modelValue)"
  >
    <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
  </button></template
>

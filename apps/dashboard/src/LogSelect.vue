<script setup lang="ts" generic="T extends string | number">
import { Check, ChevronDown } from "@lucide/vue";
import { computed, nextTick, onUnmounted, ref, useId } from "vue";

const props = defineProps<{
  modelValue: T;
  label: string;
  options: readonly { value: T; label: string }[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const id = useId();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLDivElement>();
const open = ref(false);
const active = ref(0);
const position = ref({ top: "0px", left: "0px", width: "160px" });
const selected = computed(() => props.options.find((option) => option.value === props.modelValue));

function place() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const height = Math.min(props.options.length * 36 + 8, 260);
  const width = Math.max(rect.width, 160);
  position.value = {
    top: `${rect.bottom + height + 8 <= innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`,
    left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
    width: `${width}px`,
  };
}

function close(focus = false) {
  open.value = false;
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", focusOutside);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
  if (focus) trigger.value?.focus();
}

function outside(event: PointerEvent) {
  if (
    event.target instanceof Node &&
    !menu.value?.contains(event.target) &&
    !trigger.value?.contains(event.target)
  )
    close();
}
function focusOutside(event: FocusEvent) {
  if (
    event.target instanceof Node &&
    !menu.value?.contains(event.target) &&
    !trigger.value?.contains(event.target)
  )
    close();
}

async function show(direction = 1) {
  active.value = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.modelValue),
  );
  if (direction < 0 && active.value === 0) active.value = props.options.length - 1;
  open.value = true;
  place();
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", focusOutside);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  await nextTick();
  menu.value?.focus();
}

function choose(index: number) {
  const option = props.options[index];
  if (option) emit("update:modelValue", option.value);
  close(true);
}

async function keydown(event: KeyboardEvent) {
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key))
    event.preventDefault();
  if (event.key === "ArrowDown") active.value = (active.value + 1) % props.options.length;
  if (event.key === "ArrowUp")
    active.value = (active.value + props.options.length - 1) % props.options.length;
  if (event.key === "Home") active.value = 0;
  if (event.key === "End") active.value = props.options.length - 1;
  if (event.key === "Enter" || event.key === " ") choose(active.value);
  if (event.key === "Escape" || event.key === "Tab") close(true);
  await nextTick();
  menu.value
    ?.querySelector(`#${CSS.escape(`${id}-${active.value}`)}`)
    ?.scrollIntoView({ block: "nearest" });
}
onUnmounted(() => close());
</script>

<template>
  <button
    ref="trigger"
    class="select-trigger"
    type="button"
    role="combobox"
    :aria-label="props.label"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="`${id}-menu`"
    @click="open ? close(true) : show()"
    @keydown.down.prevent="show()"
    @keydown.up.prevent="show(-1)"
  >
    <span>{{ selected?.label ?? props.label }}</span><ChevronDown :size="16" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="`${id}-menu`"
      ref="menu"
      role="listbox"
      class="select-menu"
      :style="position"
      tabindex="-1"
      :aria-label="props.label"
      :aria-activedescendant="`${id}-${active}`"
      @keydown="keydown"
    >
      <button
        v-for="(option, index) in props.options"
        :id="`${id}-${index}`"
        :key="option.value"
        class="select-option"
        :class="{ active: active === index }"
        type="button"
        role="option"
        tabindex="-1"
        :aria-selected="option.value === props.modelValue"
        @pointermove="active = index"
        @click="choose(index)"
      >
        <span>{{ option.label }}</span>
        <Check v-if="option.value === props.modelValue" :size="16" aria-hidden="true" />
      </button>
    </div>
  </Teleport>
</template>

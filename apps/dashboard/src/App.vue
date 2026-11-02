<script setup lang="ts">
import MessagesPage from "./MessagesPage.vue";
import SettingsPage from "./SettingsPage.vue";

const settings = location.pathname === "/settings";
document.title = `${settings ? "设置" : "消息日志"} · Hina`;
</script>
<template
  ><SettingsPage v-if="settings" /><MessagesPage v-else /></template
>

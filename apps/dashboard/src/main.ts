import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

let theme: string | null = null;
try {
  theme = localStorage.getItem("hina-theme");
} catch {
  /* 存储受限时仍可使用页面。 */
}
document.documentElement.dataset.theme =
  theme === "light" || theme === "dark"
    ? theme
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
createApp(App).mount("#app");

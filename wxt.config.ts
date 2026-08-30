import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "n8n HTTP Inspector",
    description:
      "Debug HTTP Request node calls in n8n workflows — surfaces request/response details the built-in UI hides",
    version: "0.1.0",
    permissions: ["storage", "tabs"],
    host_permissions: ["https://*.app.n8n.cloud/*"],
    icons: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    },
    action: {
      default_title: "n8n HTTP Inspector",
      default_icon: {
        "16": "icons/icon16.png",
        "48": "icons/icon48.png",
      },
    },
    // options_page opens in a full tab — needed for chrome.permissions.request()
    // to work. options_ui (embedded panel) blocks the permission prompt.
    options_page: "settings.html",
  },
  srcDir: "src",
});

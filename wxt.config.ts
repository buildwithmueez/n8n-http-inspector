import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "n8n HTTP Inspector",
    short_name: "HTTP Inspector",
    description:
      "Debug HTTP Request node calls in n8n workflows — surfaces request/response details the built-in UI hides",
    version: "1.0.0",
    homepage_url: "https://github.com/mueez/n8n-http-inspector",
    // tabs permission is required to read tab.url in action.onClicked (MV3)
    permissions: ["storage", "tabs"],
    host_permissions: ["https://*.app.n8n.cloud/*"],
    icons: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    },
    action: {
      default_title: "n8n HTTP Inspector — Click to open settings",
      default_icon: {
        "16": "icons/icon16.png",
        "48": "icons/icon48.png",
        "128": "icons/icon128.png",
      },
    },
    // options_page opens in a full tab — required for chrome.permissions.request()
    // to work. options_ui (embedded panel) blocks the permission prompt.
    options_page: "settings.html",
  },
  srcDir: "src",
});

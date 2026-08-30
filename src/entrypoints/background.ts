/**
 * background.ts — WXT background service worker
 *
 * Handles:
 *  - Toolbar icon click → opens/focuses the active tab (for future popup support)
 *  - Dynamic host permission management for self-hosted n8n instances
 */

export default defineBackground({
  type: "module",

  main() {
    // Toolbar icon click — open the options page so users can register
    // their self-hosted n8n domain.
    browser.action.onClicked.addListener(async (tab) => {
      if (!tab.id) return;

      // Check if this tab already has an n8n page active
      const url = tab.url ?? "";
      if (isN8nUrl(url)) {
        // Panel is injected in-page — clicking the toolbar icon is a no-op here
        // (the in-page toggle button is the primary UI trigger).
        // We could send a message to toggle the panel, but that requires
        // the content script to be active. For now, open options.
      }

      // Open settings page
      browser.runtime.openOptionsPage();
    });

    console.debug("[n8n HTTP Inspector] Background service worker started.");
  },
});

function isN8nUrl(url: string): boolean {
  return (
    url.includes(".app.n8n.cloud") ||
    url.includes("/workflow/") ||
    url.includes("/workflows")
  );
}

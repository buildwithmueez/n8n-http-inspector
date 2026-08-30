/**
 * background.ts — WXT background service worker
 *
 * Handles:
 *  - Toolbar icon click → opens the settings page so users can register
 *    their self-hosted n8n domain
 *  - Dynamic host permission management is handled in the settings page
 */

export default defineBackground({
  type: "module",

  main() {
    // Toolbar icon click — open the settings page for domain registration.
    // The primary debugging UI is the floating panel injected into the n8n
    // page itself; the toolbar icon is just an entry point to settings.
    browser.action.onClicked.addListener((tab) => {
      if (!tab.id) return;
      browser.runtime.openOptionsPage().catch(() => {
        // Settings page failed to open — nothing useful we can do here
      });
    });
  },
});

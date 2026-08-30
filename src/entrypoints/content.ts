/**
 * content.ts — WXT content script entrypoint (ISOLATED world)
 */

import { parseExecution } from "../modules/parser";
import { InspectorPanel } from "../modules/panel-ui";

const INTERCEPTOR_EVENT = "n8n-inspector:execution-data";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",

  async main() {
    if (!isN8nPage()) {
      await sleep(2000);
      if (!isN8nPage()) return;
    }

    console.debug("[n8n HTTP Inspector] n8n detected — mounting panel.");

    const panel = new InspectorPanel();
    panel.mount();

    // Accumulate calls from every execution — do NOT clear on SPA nav.
    // Only cleared by user clicking the trash button or actual page reload
    // (page reload destroys the content script and allCalls resets automatically).
    window.addEventListener(INTERCEPTOR_EVENT, (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ url: string; data: unknown }>;
      const { url, data } = event.detail;

      // Skip background polling endpoints — these fetch previous execution
      // summaries and would show stale/irrelevant data
      if (
        url.includes("last-successful") ||
        url.includes("last-failed") ||
        url.includes("last-execution")
      ) return;

      panel.showStatus("loading");

      setTimeout(() => {
        try {
          const calls = parseExecution(data);
          panel.addCalls(calls);
        } catch (err) {
          console.error("[n8n HTTP Inspector] Parse error:", err);
          panel.showStatus("empty");
        }
      }, 50);
    });
  },
});

// ---------------------------------------------------------------------------

function isN8nPage(): boolean {
  const href = location.href;
  const hostname = location.hostname;
  const title = document.title.toLowerCase();

  if (hostname.endsWith(".app.n8n.cloud")) return true;
  if (href.includes("/workflow/") || href.includes("/workflows")) return true;
  if (href.includes("/executions")) return true;
  if (title.includes("n8n")) return true;

  const win = window as Record<string, unknown>;
  if (win.n8nVersion !== undefined) return true;
  if (win.n8nBaseUrl !== undefined) return true;

  const appEl = document.getElementById("app");
  if (appEl) {
    if (appEl.dataset.n8n !== undefined) return true;
    for (const meta of Array.from(document.querySelectorAll("meta"))) {
      const content = (meta.getAttribute("content") ?? "").toLowerCase();
      const name = (meta.getAttribute("name") ?? "").toLowerCase();
      if (content.includes("n8n") || name.includes("n8n")) return true;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const hostname = location.hostname;

  // ── Strong signals (unambiguous) ────────────────────────────────────────

  // n8n Cloud official domain
  if (hostname.endsWith(".app.n8n.cloud")) return true;

  // n8n injects these globals on every page of the editor
  const win = window as Record<string, unknown>;
  if (win.n8nVersion !== undefined) return true;
  if (win.n8nBaseUrl !== undefined) return true;

  // ── DOM signals (only checked after a 2s delay, so DOM is settled) ──────

  // n8n's Vue app root sets data-n8n on #app
  const appEl = document.getElementById("app");
  if (appEl?.dataset.n8n !== undefined) return true;

  // n8n sets a <meta name="n8n-*"> tag on its pages
  for (const meta of Array.from(document.querySelectorAll("meta[name]"))) {
    if ((meta.getAttribute("name") ?? "").toLowerCase().startsWith("n8n-")) return true;
  }

  // n8n's frontend emits a specific stylesheet or script identifier in the DOM
  // (check for n8n-specific CSS class that only the editor renders)
  if (document.querySelector(".n8n-tooltip, .el-button--primary[data-test-id], [data-test-id='workflow-canvas']")) {
    return true;
  }

  // ── Broader fallbacks for self-hosted / embedded instances ───────────────

  // Any page whose URL path contains /workflow/ or /workflows — n8n's SPA
  // routes all workflow editing under these paths
  if (/\/workflows?(\/|$)/.test(location.pathname)) return true;

  // n8n's #app div is always present in the editor, even when data-n8n isn't set.
  // Pair it with a path check to avoid false-positives on unrelated Vue apps.
  if (appEl && /\/(workflow|executions?|credentials?|variables|tags)(\/|$)/.test(location.pathname)) return true;

  // n8n uses __vue_app__ on its root DOM element (Vue 3 internals)
  if (appEl && "__vue_app__" in appEl) return true;

  // n8n injects a <title> containing "n8n" (editor and self-hosted instances)
  if (document.title.toLowerCase().includes("n8n")) return true;

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

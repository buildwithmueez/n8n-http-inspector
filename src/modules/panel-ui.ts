/**
 * panel-ui.ts
 *
 * Floating, draggable, resizable inspector panel.
 * - Glassmorphism design: backdrop-filter blur, translucent surfaces
 * - Syntax highlighted JSON/XML (regex-based, no library)
 * - Results stack across executions
 * - Search, clear, copy buttons
 * - Error runs shown with full detail
 */

import type { HttpNodeCall } from "./parser";
import { buildCurlCommand } from "./curl";
import { diagnose } from "./diagnosis";
import { scanHeaders, scanBody, redactHeaders, redactString, type RedactionFinding } from "./redaction";
import { diffCalls, type CallDiff } from "./diff";

const PANEL_ID = "n8n-http-inspector-panel";
const TOGGLE_BTN_ID = "n8n-http-inspector-toggle";
const STORAGE_KEY_POS = "n8n_inspector_pos";

let allCalls: Array<HttpNodeCall & { execId: number }> = [];
let execCounter = 0;
let searchQuery = "";
// Diff: stores the two call indices selected for comparison (indices into allCalls)
let diffSelection: [number, number] | null = null;
let diffMode = false;

export class InspectorPanel {
  private panel: HTMLElement | null = null;
  private toggleBtn: HTMLElement | null = null;
  private callList: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private diffContainer: HTMLElement | null = null;
  private isVisible = true;

  private isDragging = false;
  private dragOffX = 0;
  private dragOffY = 0;

  private isResizing = false;
  private resizeDir = "";
  private rsX = 0; private rsY = 0;
  private rsW = 0; private rsH = 0;
  private rsL = 0; private rsT = 0;

  mount() {
    if (document.getElementById(PANEL_ID)) return;
    this.injectStyles();
    this.buildToggleButton();
    this.buildPanel();
    this.showStatus("idle");
  }

  unmount() {
    this.panel?.remove();
    this.toggleBtn?.remove();
    document.getElementById("n8n-inspector-styles")?.remove();
    this.panel = null;
    this.toggleBtn = null;
  }

  addCalls(calls: HttpNodeCall[]) {
    if (!this.callList) return;
    if (calls.length === 0) {
      if (allCalls.length === 0) this.showStatus("empty");
      return;
    }
    execCounter++;
    allCalls.push(...calls.map((c) => ({ ...c, execId: execCounter })));
    this.showStatus("hidden");
    this.rerender();
    if (!this.isVisible) this.openPanel();
  }

  clearAllCalls() {
    allCalls = [];
    execCounter = 0;
    diffSelection = null;
    diffMode = false;
    if (this.callList) this.callList.innerHTML = "";
    if (this.diffContainer) { this.diffContainer.innerHTML = ""; this.diffContainer.hidden = true; }
    if (this.searchInput) { this.searchInput.value = ""; searchQuery = ""; }
    this.updateCount();
    this.showStatus("idle");
  }

  showStatus(state: "idle" | "loading" | "empty" | "hidden") {
    if (!this.statusEl) return;
    const msgs: Record<string, string> = {
      idle: "Run a workflow to see HTTP call details.",
      loading: "⏳ Intercepting…",
      empty: "No HTTP Request nodes found in this execution.",
      hidden: "",
    };
    this.statusEl.textContent = msgs[state] ?? "";
    this.statusEl.style.display = state === "hidden" ? "none" : "block";
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private rerender() {
    if (!this.callList) return;
    this.callList.innerHTML = "";

    const q = searchQuery.toLowerCase().trim();
    const filtered = q
      ? allCalls.filter(
          (c) =>
            c.nodeName.toLowerCase().includes(q) ||
            (c.url ?? "").toLowerCase().includes(q) ||
            (c.method ?? "").toLowerCase().includes(q) ||
            String(c.statusCode ?? "").includes(q) ||
            (c.error ?? "").toLowerCase().includes(q)
        )
      : allCalls;

    if (filtered.length === 0 && q) {
      this.statusEl!.textContent = `No results for "${q}"`;
      this.statusEl!.style.display = "block";
      this.updateCount();
      return;
    }

    this.showStatus("hidden");
    [...filtered].reverse().forEach((call, _renderedIdx) => {
      // Pass the stable allCalls index so diff selection works correctly
      const callIdx = allCalls.indexOf(call);
      this.callList!.appendChild(this.buildCallCard(call, callIdx));
    });
    this.updateCount();
    // In diff mode, show all diff checkboxes
    if (diffMode) {
      this.callList!.querySelectorAll<HTMLElement>(".ni-diff-row").forEach((el) => { el.hidden = false; });
    }
  }

  private updateCount() {
    if (!this.countEl) return;
    const q = searchQuery.toLowerCase().trim();
    const total = allCalls.length;
    const vis = q ? allCalls.filter(c =>
      c.nodeName.toLowerCase().includes(q) ||
      (c.url ?? "").toLowerCase().includes(q) ||
      (c.method ?? "").toLowerCase().includes(q) ||
      String(c.statusCode ?? "").includes(q)
    ).length : total;
    this.countEl.textContent = total === 0 ? "" : q ? `${vis}/${total}` : `${total} call${total !== 1 ? "s" : ""}`;
  }

  // ---------------------------------------------------------------------------
  // DOM builders
  // ---------------------------------------------------------------------------

  private buildToggleButton() {
    const btn = document.createElement("button");
    btn.id = TOGGLE_BTN_ID;
    btn.title = "Toggle n8n HTTP Inspector (Alt+H)";
    btn.setAttribute("aria-label", "Toggle n8n HTTP Inspector");
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`;
    btn.addEventListener("click", () => this.togglePanel());
    document.body.appendChild(btn);
    this.toggleBtn = btn;

    // Keyboard shortcut Alt+H
    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.key === "h") this.togglePanel();
    });
  }

  private buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "n8n HTTP Inspector");

    const pos = this.loadPosition();
    panel.style.cssText = `width:${pos.w}px;height:${pos.h}px;left:${pos.x}px;top:${pos.y}px`;

    // Resize handles
    ["n","s","e","w","ne","nw","se","sw"].forEach((dir) => {
      const h = document.createElement("div");
      h.className = `ni-rh ni-rh-${dir}`;
      h.addEventListener("mousedown", (e) => this.startResize(e, dir));
      panel.appendChild(h);
    });

    // Header
    const header = document.createElement("div");
    header.className = "ni-header";
    header.addEventListener("mousedown", (e) => this.startDrag(e));

    const title = document.createElement("span");
    title.className = "ni-title";
    title.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>n8n Inspector`;

    this.countEl = document.createElement("span");
    this.countEl.className = "ni-count";

    const hRight = document.createElement("div");
    hRight.className = "ni-header-right";

    const clearBtn = this.iconBtn(
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>`,
      "Clear all results"
    );
    clearBtn.addEventListener("click", () => this.clearAllCalls());

    const diffToggleBtn = this.iconBtn(
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="18" y2="18"></line><polyline points="17 9 20 12 17 15"></polyline></svg>`,
      "Compare two runs (Diff mode)"
    );
    diffToggleBtn.id = "ni-diff-toggle-btn";
    diffToggleBtn.addEventListener("click", () => this.toggleDiffMode(diffToggleBtn));

    const closeBtn = this.iconBtn(
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
      "Close (Alt+H)"
    );
    closeBtn.addEventListener("click", () => this.closePanel());

    hRight.append(diffToggleBtn, clearBtn, closeBtn);
    header.append(title, this.countEl, hRight);

    // Search bar
    const searchBar = document.createElement("div");
    searchBar.className = "ni-search-bar";
    searchBar.innerHTML = `<svg class="ni-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "ni-search-input";
    input.placeholder = "Filter by name, URL, method, status…";
    input.setAttribute("aria-label", "Search calls");
    input.addEventListener("input", () => {
      searchQuery = input.value;
      if (allCalls.length > 0) this.rerender();
    });
    this.searchInput = input;

    const clearS = this.iconBtn(
      `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
      "Clear search"
    );
    clearS.style.padding = "3px 4px";
    clearS.addEventListener("click", () => {
      input.value = "";
      searchQuery = "";
      allCalls.length > 0 ? this.rerender() : this.showStatus("idle");
    });

    searchBar.append(input, clearS);

    // Call list + status
    const callList = document.createElement("div");
    callList.className = "ni-call-list";
    callList.setAttribute("role", "list");

    const statusEl = document.createElement("p");
    statusEl.className = "ni-status";

    // Diff container (hidden until diff mode active)
    const diffContainer = document.createElement("div");
    diffContainer.className = "ni-diff-container";
    diffContainer.hidden = true;

    panel.append(header, searchBar, statusEl, callList, diffContainer);
    document.body.appendChild(panel);

    this.panel = panel;
    this.callList = callList;
    this.statusEl = statusEl;
    this.diffContainer = diffContainer;

    document.addEventListener("mousemove", (e) => this.onMouseMove(e));
    document.addEventListener("mouseup", () => this.onMouseUp());
  }

  private iconBtn(svg: string, title: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "ni-icon-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = svg;
    return btn;
  }

  private buildCallCard(call: HttpNodeCall & { execId: number }, idx: number): HTMLElement {
    const isError = !!call.error || call.executionStatus === "error";
    const card = document.createElement("div");
    card.className = `ni-card${isError ? " ni-card--error" : ""}`;
    card.setAttribute("role", "listitem");

    // ── Card header ──
    const hBtn = document.createElement("button");
    hBtn.className = "ni-card-header";
    hBtn.setAttribute("aria-expanded", "false");

    const cardLeft = document.createElement("span");
    cardLeft.className = "ni-card-left";

    if (call.method) {
      const m = document.createElement("span");
      m.className = `ni-method ni-method--${call.method.toLowerCase()}`;
      m.textContent = call.method.toUpperCase();
      cardLeft.appendChild(m);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "ni-node-name";
    nameEl.title = call.nodeName;
    nameEl.textContent = call.nodeName;
    cardLeft.appendChild(nameEl);

    if (call.url) {
      const urlPrev = document.createElement("span");
      urlPrev.className = "ni-url-preview";
      urlPrev.title = call.url;
      urlPrev.textContent = truncate(call.url, 40);
      cardLeft.appendChild(urlPrev);
    }

    const cardRight = document.createElement("span");
    cardRight.className = "ni-card-right";

    const statusBadge = document.createElement("span");
    if (isError) {
      statusBadge.className = "ni-badge ni-badge--error";
      statusBadge.textContent = String(call.statusCode ?? "ERR");
    } else if (call.statusCode) {
      statusBadge.className = `ni-badge ${statusClass(call.statusCode)}`;
      statusBadge.textContent = String(call.statusCode);
    } else {
      statusBadge.className = "ni-badge ni-badge--unknown";
      statusBadge.textContent = "—";
    }
    cardRight.appendChild(statusBadge);

    if (call.executionTimeMs != null) {
      const t = document.createElement("span");
      t.className = "ni-timing";
      t.textContent = `${call.executionTimeMs}ms`;
      cardRight.appendChild(t);
    }

    const execB = document.createElement("span");
    execB.className = "ni-exec-badge";
    execB.title = `Execution run #${call.execId}`;
    execB.textContent = `#${call.execId}`;
    cardRight.appendChild(execB);

    cardRight.insertAdjacentHTML("beforeend", `<svg class="ni-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`);

    hBtn.append(cardLeft, cardRight);

    // ── Card details (DOM-built for live collapse) ──
    const details = document.createElement("div");
    details.className = "ni-card-details";
    details.hidden = true;
    this.populateCallDetails(details, call);

    // ── Diff checkbox (shown in diff mode) ──
    const diffRow = document.createElement("div");
    diffRow.className = "ni-diff-row";
    diffRow.hidden = !diffMode;
    const diffCb = document.createElement("input");
    diffCb.type = "checkbox";
    diffCb.className = "ni-diff-cb";
    diffCb.setAttribute("aria-label", `Select run #${call.execId} for diff`);
    const diffLbl = document.createElement("label");
    diffLbl.className = "ni-diff-lbl";
    diffLbl.textContent = `Select for diff (#${call.execId})`;
    diffRow.append(diffCb, diffLbl);
    diffCb.addEventListener("change", () => this.handleDiffSelect(allCalls.indexOf(call), diffCb.checked));

    hBtn.addEventListener("click", () => {
      const nowOpen = hBtn.getAttribute("aria-expanded") !== "true";
      hBtn.setAttribute("aria-expanded", String(nowOpen));
      details.hidden = !nowOpen;
      card.classList.toggle("ni-card--open", nowOpen);
    });

    card.append(hBtn, diffRow, details);
    return card;
  }

  private populateCallDetails(container: HTMLElement, call: HttpNodeCall) {
    // ── cURL button row ────────────────────────────────────────────────────
    const curlBar = document.createElement("div");
    curlBar.className = "ni-action-bar";
    const curlBtn = document.createElement("button");
    curlBtn.className = "ni-action-btn";
    curlBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg> Copy as cURL`;
    curlBtn.addEventListener("click", () => {
      const cmd = buildCurlCommand(call);
      navigator.clipboard.writeText(cmd).then(() => {
        curlBtn.textContent = "✓ Copied!";
        setTimeout(() => {
          curlBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg> Copy as cURL`;
        }, 2000);
      }).catch(() => {
        curlBtn.textContent = "Copy failed — paste manually";
        setTimeout(() => {
          curlBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg> Copy as cURL`;
        }, 3000);
      });
    });
    curlBar.appendChild(curlBtn);
    container.appendChild(curlBar);

    // ── Diagnosis hint ─────────────────────────────────────────────────────
    const diagnosis = diagnose(call);
    if (diagnosis) {
      const hint = document.createElement("div");
      hint.className = `ni-diagnosis ni-diagnosis--${diagnosis.severity}`;
      hint.innerHTML = `
        <div class="ni-diagnosis-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          <strong>${escapeHtml(diagnosis.label)}</strong>
        </div>
        <p class="ni-diagnosis-hint">${escapeHtml(diagnosis.hint)}</p>
        <p class="ni-diagnosis-fix"><span class="ni-diagnosis-fix-label">Fix →</span> ${escapeHtml(diagnosis.fix)}</p>`;
      container.appendChild(hint);
    }

    // ── Secrets warning ────────────────────────────────────────────────────
    const secretFindings: RedactionFinding[] = [];
    if (call.requestHeaders) secretFindings.push(...scanHeaders(call.requestHeaders, "Request Headers"));
    if (call.responseHeaders) secretFindings.push(...scanHeaders(call.responseHeaders, "Response Headers"));
    const bodyStr = call.responseBody != null
      ? (typeof call.responseBody === "string" ? call.responseBody : JSON.stringify(call.responseBody))
      : null;
    if (bodyStr) secretFindings.push(...scanBody(bodyStr, "Response Body"));

    if (secretFindings.length > 0) {
      const warn = document.createElement("div");
      warn.className = "ni-secret-warn";
      let redacted = false;
      warn.innerHTML = `
        <div class="ni-secret-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          <strong>${secretFindings.length} possible secret${secretFindings.length > 1 ? "s" : ""} detected</strong>
          <span class="ni-secret-hint">Safe to share?</span>
        </div>
        <ul class="ni-secret-list">${secretFindings.map(f =>
          `<li><span class="ni-secret-type">${escapeHtml(f.type)}</span> in <span class="ni-secret-loc">${escapeHtml(f.location)}</span> — <code>${escapeHtml(f.preview)}</code></li>`
        ).join("")}</ul>`;

      const redactBtn = document.createElement("button");
      redactBtn.className = "ni-action-btn ni-action-btn--warn";
      redactBtn.textContent = "Redact secrets in view";
      redactBtn.addEventListener("click", () => {
        if (redacted) return;
        redacted = true;
        redactBtn.textContent = "✓ Redacted";
        redactBtn.disabled = true;

        // ── Redact header values ─────────────────────────────────────────
        container.querySelectorAll<HTMLElement>(".ni-hn").forEach((nameEl) => {
          const valEl = nameEl.nextElementSibling as HTMLElement | null;
          if (!valEl) return;
          const val = valEl.textContent ?? "";
          const redactedVal = redactString(val);
          if (redactedVal !== val) valEl.textContent = redactedVal;
        });

        // ── Redact response body: re-render from redacted raw string ─────
        // bodyStr is captured in this closure. We find the section we marked
        // with data-ni-section="Response Body" and replace its <pre> element
        // with a freshly-highlighted version of the redacted string.
        if (bodyStr) {
          const bodySectionEl = container.querySelector<HTMLElement>(
            '[data-ni-section="Response Body"] .ni-sb'
          );
          if (bodySectionEl) {
            const redactedBody = redactString(bodyStr);
            const newPre = highlightCodeEl(redactedBody);
            // Replace existing content — the section body holds exactly one child
            bodySectionEl.innerHTML = "";
            bodySectionEl.appendChild(newPre);
            // Also update the copy button's data so the copy reflects redacted text
            const copyBtn = container.querySelector<HTMLElement>(
              '[data-ni-section="Response Body"] .ni-copy-btn'
            );
            if (copyBtn) copyBtn.dataset.copy = redactedBody;
          }
        }
      });
      warn.appendChild(redactBtn);
      container.appendChild(warn);
    }

    // ── URL row ────────────────────────────────────────────────────────────
    const urlVal = document.createElement("span");
    if (call.url) {
      urlVal.className = "ni-mono ni-url";
      urlVal.textContent = call.url;
    } else {
      urlVal.className = "ni-na";
      urlVal.textContent = "Not captured — available in node parameters";
    }
    container.appendChild(this.fieldRowEl("URL", urlVal, call.url ?? undefined));

    // ── Error banner ───────────────────────────────────────────────────────
    if (call.error) {
      const banner = document.createElement("div");
      banner.className = "ni-error-banner";
      banner.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
      const body = document.createElement("div");
      body.className = "ni-error-body";
      body.innerHTML = `<strong>Error</strong><span>${escapeHtml(call.error)}</span>`;
      banner.appendChild(body);
      container.appendChild(banner);
    }

    // ── Status row ─────────────────────────────────────────────────────────
    if (call.statusCode != null) {
      const sv = document.createElement("span");
      sv.className = `ni-mono ${call.statusCode >= 400 ? "ni-err" : "ni-ok"}`;
      sv.textContent = `${call.statusCode}${call.statusMessage ? " " + call.statusMessage : ""}`;
      container.appendChild(this.fieldRowEl("Status", sv));
    } else if (!call.error) {
      const sv = document.createElement("span");
      sv.className = "ni-na";
      sv.textContent = `Enable "Include Response Headers and Status" in node settings`;
      container.appendChild(this.fieldRowEl("Status", sv));
    }

    // ── Timing row ─────────────────────────────────────────────────────────
    const timeParts: string[] = [];
    if (call.startTime != null) timeParts.push(`Started: ${new Date(call.startTime).toLocaleTimeString()}`);
    if (call.executionTimeMs != null) timeParts.push(`${call.executionTimeMs}ms`);
    if (call.executionStatus) timeParts.push(call.executionStatus);
    if (timeParts.length) {
      const tv = document.createElement("span");
      tv.className = "ni-mono ni-dim";
      tv.textContent = timeParts.join("  ·  ");
      container.appendChild(this.fieldRowEl("Timing", tv));
    }

    // ── Collapsible sections ───────────────────────────────────────────────
    if (call.requestHeaders) {
      container.appendChild(this.sectionEl("Request Headers", formatHeadersEl(call.requestHeaders), JSON.stringify(call.requestHeaders, null, 2), true));
    }
    if (call.requestBody) {
      container.appendChild(this.sectionEl("Request Body", highlightCodeEl(call.requestBody), call.requestBody));
    }
    if (call.responseHeaders) {
      container.appendChild(this.sectionEl("Response Headers", formatHeadersEl(call.responseHeaders), JSON.stringify(call.responseHeaders, null, 2), true));
    }

    if (bodyStr) {
      const bodySec = this.sectionEl("Response Body", highlightCodeEl(bodyStr), bodyStr);
      bodySec.dataset.niSection = "Response Body";
      container.appendChild(bodySec);
    } else if (!call.error) {
      const naEl = document.createElement("span");
      naEl.className = "ni-na";
      naEl.textContent = "No body captured. Check node output items or enable response options.";
      container.appendChild(this.sectionEl("Response Body", naEl));
    }

    if (call.errorDetail) {
      const cause = call.errorDetail.cause as Record<string, unknown> | undefined;
      if (cause?.body) {
        const bs = typeof cause.body === "string" ? cause.body : JSON.stringify(cause.body, null, 2);
        container.appendChild(this.sectionEl("Error Response Body", highlightCodeEl(bs), bs));
      }
      const desc = call.errorDetail.description as string | undefined;
      if (desc && desc !== call.error) {
        const dv = document.createElement("span");
        dv.className = "ni-err";
        dv.textContent = desc;
        container.appendChild(this.fieldRowEl("Error Detail", dv));
      }
    }
  }

  /** A label + value row (non-collapsible) */
  private fieldRowEl(label: string, valueEl: HTMLElement, copyValue?: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "ni-field";

    const lbl = document.createElement("span");
    lbl.className = "ni-fl";
    lbl.textContent = label;
    row.appendChild(lbl);

    if (copyValue) {
      const btn = document.createElement("button");
      btn.className = "ni-copy-btn";
      btn.dataset.copy = copyValue;
      btn.setAttribute("aria-label", `Copy ${label}`);
      btn.textContent = "Copy";
      row.appendChild(btn);
    }

    valueEl.classList.add("ni-fv");
    row.appendChild(valueEl);
    return row;
  }

  /** A collapsible section with header, chevron, copy button, and body */
  private sectionEl(
    label: string,
    contentEl: HTMLElement,
    copyValue?: string,
    startOpen = false
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ni-section";

    // Section header (clickable to collapse)
    const sh = document.createElement("button");
    sh.className = "ni-sh";
    sh.setAttribute("aria-expanded", String(startOpen));

    const sl = document.createElement("span");
    sl.className = "ni-sl";
    sl.textContent = label;
    sh.appendChild(sl);

    const shRight = document.createElement("span");
    shRight.className = "ni-sh-right";

    if (copyValue) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "ni-copy-btn";
      copyBtn.dataset.copy = copyValue;
      copyBtn.setAttribute("aria-label", `Copy ${label}`);
      copyBtn.textContent = "Copy";
      // Stop the section toggle from firing when copy is clicked
      copyBtn.addEventListener("click", (e) => e.stopPropagation());
      shRight.appendChild(copyBtn);
    }

    shRight.insertAdjacentHTML("beforeend", `<svg class="ni-sec-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`);
    sh.appendChild(shRight);

    // Body
    const sb = document.createElement("div");
    sb.className = "ni-sb";
    sb.hidden = !startOpen;
    sb.appendChild(contentEl);

    sh.addEventListener("click", () => {
      const open = sh.getAttribute("aria-expanded") !== "true";
      sh.setAttribute("aria-expanded", String(open));
      sb.hidden = !open;
      wrap.classList.toggle("ni-section--open", open);
    });

    // Default collapsed unless startOpen
    wrap.classList.toggle("ni-section--open", startOpen);
    wrap.append(sh, sb);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Panel visibility
  // ---------------------------------------------------------------------------

  private togglePanel() { this.isVisible ? this.closePanel() : this.openPanel(); }

  private openPanel() {
    if (!this.panel) return;
    this.panel.style.display = "flex";
    this.toggleBtn?.classList.add("ni-toggle--active");
    this.isVisible = true;
  }

  private closePanel() {
    if (!this.panel) return;
    this.panel.style.display = "none";
    this.toggleBtn?.classList.remove("ni-toggle--active");
    this.isVisible = false;
  }

  // ---------------------------------------------------------------------------
  // Diff mode
  // ---------------------------------------------------------------------------

  private toggleDiffMode(btn: HTMLButtonElement) {
    diffMode = !diffMode;
    diffSelection = null;
    btn.classList.toggle("ni-icon-btn--active", diffMode);
    btn.title = diffMode ? "Exit diff mode" : "Compare two runs (Diff mode)";
    if (this.diffContainer) {
      this.diffContainer.innerHTML = "";
      this.diffContainer.hidden = true;
    }
    this.rerender();
  }

  private handleDiffSelect(idx: number, checked: boolean) {
    if (!diffMode) return;

    if (checked) {
      if (!diffSelection) {
        diffSelection = [idx, -1];
      } else if (diffSelection[1] === -1) {
        diffSelection[1] = idx;
        // Both selected — render diff
        this.renderDiff(diffSelection[0], diffSelection[1]);
      } else {
        // Already have two — replace the older one
        diffSelection = [diffSelection[1], idx];
        this.renderDiff(diffSelection[0], diffSelection[1]);
      }
    } else {
      // Deselect
      if (diffSelection) {
        if (diffSelection[0] === idx) diffSelection[0] = -1;
        if (diffSelection[1] === idx) diffSelection[1] = -1;
        if (diffSelection[0] === -1 && diffSelection[1] === -1) diffSelection = null;
      }
      if (this.diffContainer) {
        this.diffContainer.innerHTML = "";
        this.diffContainer.hidden = true;
      }
    }
  }

  private renderDiff(idxA: number, idxB: number) {
    if (!this.diffContainer) return;
    const a = allCalls[idxA];
    const b = allCalls[idxB];
    if (!a || !b) return;

    const result = diffCalls(a, b);
    this.diffContainer.hidden = false;
    this.diffContainer.innerHTML = "";

    // Header
    const dh = document.createElement("div");
    dh.className = "ni-diff-header";
    dh.innerHTML = `
      <span class="ni-diff-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="18" y2="18"></line><polyline points="17 9 20 12 17 15"></polyline></svg>
        Diff: <em>#${result.execIdA}</em> vs <em>#${result.execIdB}</em>
        ${result.identical ? '<span class="ni-diff-identical">Identical</span>' : ''}
      </span>
      <div class="ni-diff-col-labels">
        <span class="ni-diff-col-a">Run #${result.execIdA}</span>
        <span class="ni-diff-col-b">Run #${result.execIdB}</span>
      </div>`;
    this.diffContainer.appendChild(dh);

    // Rows
    for (const field of result.fields) {
      const row = document.createElement("div");
      row.className = `ni-diff-row-data ni-diff-${field.status}`;

      const label = document.createElement("div");
      label.className = "ni-diff-label";
      label.textContent = field.label;

      // Redact secrets in body and header fields before display.
      // Header fields are labelled "Req Header: <name>" / "Res Header: <name>".
      // Body fields are labelled "Request Body" / "Response Body".
      const isSecret = field.label.startsWith("Req Header:") ||
        field.label.startsWith("Res Header:") ||
        field.label === "Request Body" ||
        field.label === "Response Body";
      const leftText  = isSecret ? redactString(field.left)  : field.left;
      const rightText = isSecret ? redactString(field.right) : field.right;

      const left = document.createElement("div");
      left.className = "ni-diff-cell ni-diff-cell--a";
      const leftPre = document.createElement("pre");
      leftPre.className = "ni-diff-val";
      leftPre.textContent = leftText || "(empty)";
      left.appendChild(leftPre);

      const right = document.createElement("div");
      right.className = "ni-diff-cell ni-diff-cell--b";
      const rightPre = document.createElement("pre");
      rightPre.className = "ni-diff-val";
      rightPre.textContent = rightText || "(empty)";
      right.appendChild(rightPre);

      row.append(label, left, right);
      this.diffContainer.appendChild(row);
    }

    // Scroll into view
    this.diffContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------------------------------------------------------------------------
  // Drag
  // ---------------------------------------------------------------------------

  private startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    this.isDragging = true;
    const r = this.panel!.getBoundingClientRect();
    this.dragOffX = e.clientX - r.left;
    this.dragOffY = e.clientY - r.top;
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------

  private startResize(e: MouseEvent, dir: string) {
    this.isResizing = true;
    this.resizeDir = dir;
    this.rsX = e.clientX; this.rsY = e.clientY;
    const r = this.panel!.getBoundingClientRect();
    this.rsW = r.width; this.rsH = r.height;
    this.rsL = r.left; this.rsT = r.top;
    e.preventDefault(); e.stopPropagation();
  }

  private onMouseMove(e: MouseEvent) {
    if (this.isDragging && this.panel) {
      const x = Math.max(0, Math.min(e.clientX - this.dragOffX, window.innerWidth - 100));
      const y = Math.max(0, Math.min(e.clientY - this.dragOffY, window.innerHeight - 40));
      this.panel.style.left = `${x}px`;
      this.panel.style.top = `${y}px`;
    }
    if (this.isResizing && this.panel) {
      const dx = e.clientX - this.rsX, dy = e.clientY - this.rsY;
      const MIN_W = 320, MIN_H = 200;
      let w = this.rsW, h = this.rsH, l = this.rsL, t = this.rsT;
      if (this.resizeDir.includes("e")) w = Math.max(MIN_W, this.rsW + dx);
      if (this.resizeDir.includes("s")) h = Math.max(MIN_H, this.rsH + dy);
      if (this.resizeDir.includes("w")) { w = Math.max(MIN_W, this.rsW - dx); l = this.rsL + (this.rsW - w); }
      if (this.resizeDir.includes("n")) { h = Math.max(MIN_H, this.rsH - dy); t = this.rsT + (this.rsH - h); }
      Object.assign(this.panel.style, { width: `${w}px`, height: `${h}px`, left: `${l}px`, top: `${t}px` });
    }
  }

  private onMouseUp() {
    if ((this.isDragging || this.isResizing) && this.panel) this.savePosition();
    this.isDragging = false;
    this.isResizing = false;
  }

  private savePosition() {
    if (!this.panel) return;
    const r = this.panel.getBoundingClientRect();
    try { sessionStorage.setItem(STORAGE_KEY_POS, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })); }
    catch { /* ignore */ }
  }

  private loadPosition() {
    const def = { x: window.innerWidth - 460, y: 60, w: 440, h: 540 };
    try {
      const s = sessionStorage.getItem(STORAGE_KEY_POS);
      if (s) {
        const p = JSON.parse(s);
        p.x = Math.max(0, Math.min(p.x, window.innerWidth - 100));
        p.y = Math.max(0, Math.min(p.y, window.innerHeight - 100));
        return p;
      }
    } catch { /* ignore */ }
    return def;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  private injectStyles() {
    if (document.getElementById("n8n-inspector-styles")) return;
    const style = document.createElement("style");
    style.id = "n8n-inspector-styles";
    style.textContent = CSS;
    document.head.appendChild(style);

    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-copy]") as HTMLElement | null;
      if (!btn) return;
      const text = btn.dataset.copy ?? "";
      navigator.clipboard.writeText(text).then(() => {
        const prev = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => (btn.textContent = prev), 1200);
      }).catch(() => {
        const prev = btn.textContent;
        btn.textContent = "✗";
        setTimeout(() => (btn.textContent = prev), 2000);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Syntax highlighting — proper token-by-token approach
// ---------------------------------------------------------------------------

/** Returns an HTMLElement (pre) with syntax-highlighted content */
export function highlightCodeEl(raw: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "ni-code";
  const trimmed = raw.trimStart();

  if (trimmed.startsWith("<")) {
    pre.innerHTML = tokenizeXml(raw);
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    if (parsed !== undefined) {
      pre.innerHTML = tokenizeJson(JSON.stringify(parsed, null, 2));
    } else {
      pre.textContent = raw;
    }
  }
  return pre;
}

/** Kept for backwards compat in HTML-string contexts */
export function highlightCode(raw: string): string {
  return highlightCodeEl(raw).outerHTML;
}

// JSON tokenizer — walks char-by-char to produce accurate spans
function tokenizeJson(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      out += ch === "\n" ? "\n" : ch === "\t" ? "  " : ch;
      i++; continue;
    }

    // String
    if (ch === '"') {
      let str = '"';
      i++;
      while (i < src.length) {
        const c = src[i];
        str += c;
        if (c === "\\") { i++; if (i < src.length) { str += src[i]; } }
        else if (c === '"') break;
        i++;
      }
      i++;
      // Is it a key? Peek past whitespace for colon
      let j = i;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      if (src[j] === ":") {
        out += `<span class="hl-key">${escHtml(str)}</span>`;
      } else {
        out += `<span class="hl-str">${escHtml(str)}</span>`;
      }
      continue;
    }

    // Number
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let num = "";
      if (ch === "-") { num += ch; i++; }
      while (i < src.length && /[\d.eE+\-]/.test(src[i])) { num += src[i]; i++; }
      out += `<span class="hl-num">${escHtml(num)}</span>`;
      continue;
    }

    // Keywords: true / false / null
    if (src.startsWith("true", i))  { out += `<span class="hl-kw">true</span>`;  i += 4; continue; }
    if (src.startsWith("false", i)) { out += `<span class="hl-kw">false</span>`; i += 5; continue; }
    if (src.startsWith("null", i))  { out += `<span class="hl-kw">null</span>`;  i += 4; continue; }

    // Punctuation: { } [ ] : ,
    const PUNCT: Record<string, string> = {
      "{": "hl-brace", "}": "hl-brace",
      "[": "hl-bracket", "]": "hl-bracket",
      ":": "hl-colon", ",": "hl-punct",
    };
    if (ch in PUNCT) {
      out += `<span class="${PUNCT[ch]}">${escHtml(ch)}</span>`;
      i++; continue;
    }

    out += escHtml(ch);
    i++;
  }

  return out;
}

// XML tokenizer
function tokenizeXml(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    // XML comment
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const slice = end === -1 ? src.slice(i) : src.slice(i, end + 3);
      out += `<span class="hl-comment">${escHtml(slice)}</span>`;
      i += slice.length; continue;
    }
    // CDATA
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      const slice = end === -1 ? src.slice(i) : src.slice(i, end + 3);
      out += `<span class="hl-cdata">${escHtml(slice)}</span>`;
      i += slice.length; continue;
    }
    // Processing instruction
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      const slice = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += `<span class="hl-pi">${escHtml(slice)}</span>`;
      i += slice.length; continue;
    }
    // Tag
    if (src[i] === "<") {
      // Find end of tag
      let end = i + 1;
      let inStr: string | null = null;
      while (end < src.length) {
        const c = src[end];
        if (inStr) { if (c === inStr) inStr = null; }
        else if (c === '"' || c === "'") { inStr = c; }
        else if (c === ">") { end++; break; }
        end++;
      }
      const tag = src.slice(i, end);
      out += colorizeXmlTag(tag);
      i = end; continue;
    }
    // Text content
    let text = "";
    while (i < src.length && src[i] !== "<") { text += src[i]; i++; }
    out += escHtml(text);
  }

  return out;
}

function colorizeXmlTag(tag: string): string {
  // Closing tag: </foo>
  const closeMatch = tag.match(/^<\/([^\s>]+)(>?)$/);
  if (closeMatch) {
    return `<span class="hl-punct">&lt;/</span><span class="hl-tag">${escHtml(closeMatch[1])}</span><span class="hl-punct">${closeMatch[2] ? "&gt;" : ""}</span>`;
  }

  // Opening / self-closing: <foo attr="val" />
  // Split into: opening bracket, tag name, attributes, closing
  const openMatch = tag.match(/^(<)([\w:-]+)([\s\S]*?)(\s*\/?>)$/);
  if (!openMatch) return escHtml(tag);

  const [, lt, name, attrStr, close] = openMatch;
  let attrs = "";

  // Tokenize attributes
  let j = 0;
  while (j < attrStr.length) {
    // skip whitespace
    let ws = "";
    while (j < attrStr.length && /\s/.test(attrStr[j])) { ws += attrStr[j]; j++; }
    if (ws) { attrs += ws; }
    if (j >= attrStr.length) break;

    // read attr name
    let attrName = "";
    while (j < attrStr.length && !/[\s=/>]/.test(attrStr[j])) { attrName += attrStr[j]; j++; }
    if (!attrName) { attrs += escHtml(attrStr[j] ?? ""); j++; continue; }

    // skip =
    let eq = "";
    while (j < attrStr.length && attrStr[j] === " ") { eq += " "; j++; }
    if (attrStr[j] === "=") { eq += "="; j++; }

    // read value
    let val = "";
    if (attrStr[j] === '"' || attrStr[j] === "'") {
      const q = attrStr[j]; j++;
      while (j < attrStr.length && attrStr[j] !== q) { val += attrStr[j]; j++; }
      j++;
      attrs += `<span class="hl-attr">${escHtml(attrName)}</span>${eq}<span class="hl-str">"${escHtml(val)}"</span>`;
    } else {
      attrs += `<span class="hl-attr">${escHtml(attrName)}</span>${eq}`;
    }
  }

  return `<span class="hl-punct">&lt;</span><span class="hl-tag">${escHtml(name)}</span>${attrs}<span class="hl-punct">${escHtml(close)}</span>`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function formatHeadersEl(h: Record<string, string>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ni-headers-list";
  for (const [k, v] of Object.entries(h)) {
    const row = document.createElement("div");
    row.className = "ni-hr";
    const kEl = document.createElement("span");
    kEl.className = "hl-attr ni-hn";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "ni-hv";
    vEl.textContent = v;
    row.append(kEl, vEl);
    wrap.appendChild(row);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function statusClass(code: number): string {
  if (code >= 500) return "ni-badge--error";
  if (code >= 400) return "ni-badge--warn";
  if (code >= 300) return "ni-badge--redirect";
  return "ni-badge--ok";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Short alias used inside tokenizers (avoids redefining escapeHtml) */
function escHtml(s: string): string { return escapeHtml(s); }

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttr(s: string): string {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// CSS — Glassmorphism theme
// ---------------------------------------------------------------------------

const CSS = `
/* ===== n8n HTTP Inspector — Glassmorphism theme ===== */

#n8n-http-inspector-panel {
  position: fixed;
  z-index: 2147483640;
  display: flex;
  flex-direction: column;
  /* Glass surface */
  background: rgba(10, 10, 28, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow:
    0 0 0 1px rgba(255, 109, 90, 0.12),
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 2px 8px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  color: #dde1f0;
  overflow: hidden;
  min-width: 320px;
  min-height: 200px;
}

/* ── Resize handles ── */
.ni-rh { position: absolute; z-index: 10; }
.ni-rh-n  { top:-4px;    left:12px;   right:12px;  height:8px;   cursor:n-resize; }
.ni-rh-s  { bottom:-4px; left:12px;   right:12px;  height:8px;   cursor:s-resize; }
.ni-rh-e  { right:-4px;  top:12px;    bottom:12px; width:8px;    cursor:e-resize; }
.ni-rh-w  { left:-4px;   top:12px;    bottom:12px; width:8px;    cursor:w-resize; }
.ni-rh-ne { top:-4px;    right:-4px;  width:14px;  height:14px;  cursor:ne-resize; }
.ni-rh-nw { top:-4px;    left:-4px;   width:14px;  height:14px;  cursor:nw-resize; }
.ni-rh-se { bottom:-4px; right:-4px;  width:14px;  height:14px;  cursor:se-resize; }
.ni-rh-sw { bottom:-4px; left:-4px;   width:14px;  height:14px;  cursor:sw-resize; }

/* ── Header ── */
.ni-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 9px 13px;
  background: rgba(255, 109, 90, 0.06);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.ni-header:active { cursor: grabbing; }

.ni-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #ff6d5a;
  white-space: nowrap;
}

.ni-count {
  flex: 1;
  font-size: 10px;
  color: rgba(255,255,255,0.25);
  font-family: "SF Mono","Fira Code",monospace;
  padding-left: 4px;
}

.ni-header-right { display: flex; align-items: center; gap: 2px; }

.ni-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: rgba(255,255,255,0.3);
  cursor: pointer;
  padding: 5px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
  line-height: 1;
}
.ni-icon-btn:hover {
  color: rgba(255,255,255,0.85);
  background: rgba(255,255,255,0.08);
}

/* ── Search bar ── */
.ni-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(0,0,0,0.15);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  flex-shrink: 0;
}

.ni-search-icon { color: rgba(255,255,255,0.2); display: flex; align-items: center; flex-shrink: 0; }

.ni-search-input {
  flex: 1;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  color: #dde1f0;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
  font-family: inherit;
  min-width: 0;
}
.ni-search-input:focus {
  border-color: rgba(255,109,90,0.4);
  background: rgba(255,255,255,0.07);
}
.ni-search-input::placeholder { color: rgba(255,255,255,0.2); }

/* ── Status ── */
.ni-status {
  padding: 22px 16px;
  color: rgba(255,255,255,0.25);
  font-style: italic;
  text-align: center;
  margin: 0;
  font-size: 12px;
}

/* ── Call list ── */
.ni-call-list {
  overflow-y: auto;
  flex: 1;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ni-call-list::-webkit-scrollbar { width: 4px; }
.ni-call-list::-webkit-scrollbar-track { background: transparent; }
.ni-call-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

/* ── Card ── */
.ni-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.ni-card:hover { border-color: rgba(255,255,255,0.12); }
.ni-card--open { border-color: rgba(255,109,90,0.3) !important; background: rgba(255,109,90,0.04); }
.ni-card--error { border-color: rgba(248,113,113,0.25) !important; }
.ni-card--error.ni-card--open { border-color: rgba(248,113,113,0.45) !important; }

.ni-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  gap: 6px;
  transition: background 0.12s;
}
.ni-card-header:hover { background: rgba(255,255,255,0.04); }

.ni-card-left  { display:flex; align-items:center; gap:5px; flex:1; min-width:0; }
.ni-card-right { display:flex; align-items:center; gap:4px; flex-shrink:0; }

.ni-node-name {
  font-weight: 600;
  color: #e8eaf6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.ni-url-preview {
  font-size: 10px;
  color: rgba(255,255,255,0.25);
  font-family: "SF Mono","Fira Code",monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.ni-method {
  font-family: "SF Mono","Fira Code",monospace;
  font-size: 9px;
  font-weight: 800;
  border-radius: 4px;
  padding: 2px 6px;
  letter-spacing: 0.06em;
  flex-shrink: 0;
  border: 1px solid transparent;
}
.ni-method--get    { color: #6ee7b7; background: rgba(110,231,183,0.1); border-color: rgba(110,231,183,0.2); }
.ni-method--post   { color: #93c5fd; background: rgba(147,197,253,0.1); border-color: rgba(147,197,253,0.2); }
.ni-method--put    { color: #fcd34d; background: rgba(252,211,77,0.1);  border-color: rgba(252,211,77,0.2); }
.ni-method--patch  { color: #c4b5fd; background: rgba(196,181,253,0.1); border-color: rgba(196,181,253,0.2); }
.ni-method--delete { color: #fca5a5; background: rgba(252,165,165,0.1); border-color: rgba(252,165,165,0.2); }
.ni-method--head   { color: #a3e635; background: rgba(163,230,53,0.1);  border-color: rgba(163,230,53,0.2); }

.ni-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: "SF Mono","Fira Code",monospace;
  flex-shrink: 0;
}
.ni-badge--ok       { background:rgba(74,222,128,0.15);  color:#4ade80;  border:1px solid rgba(74,222,128,0.25); }
.ni-badge--warn     { background:rgba(251,146,60,0.15);  color:#fb923c;  border:1px solid rgba(251,146,60,0.25); }
.ni-badge--error    { background:rgba(248,113,113,0.15); color:#f87171;  border:1px solid rgba(248,113,113,0.25); }
.ni-badge--redirect { background:rgba(96,165,250,0.15);  color:#60a5fa;  border:1px solid rgba(96,165,250,0.25); }
.ni-badge--unknown  { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.3); border:1px solid rgba(255,255,255,0.08); }

.ni-timing {
  font-size: 9px;
  color: rgba(255,255,255,0.3);
  font-family: "SF Mono","Fira Code",monospace;
  flex-shrink: 0;
}

.ni-exec-badge {
  font-size: 9px;
  color: rgba(255,255,255,0.2);
  font-family: "SF Mono","Fira Code",monospace;
  flex-shrink: 0;
}

.ni-chevron {
  flex-shrink: 0;
  color: rgba(255,255,255,0.2);
  transition: transform 0.18s;
}
.ni-card--open .ni-chevron { transform: rotate(180deg); color: rgba(255,109,90,0.7); }

/* ── Card details ── */
.ni-card-details[hidden] { display: none !important; }
.ni-card-details {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px 10px;
  border-top: 1px solid rgba(255,255,255,0.05);
  background: rgba(0,0,0,0.15);
}

/* Error banner */
.ni-error-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.2);
  border-radius: 6px;
  padding: 8px 10px;
  color: #fca5a5;
  font-size: 12px;
}
.ni-error-body { display: flex; flex-direction: column; gap: 2px; }
.ni-error-body strong { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; }

/* Fields */
.ni-field {
  display: grid;
  grid-template-columns: 68px auto 1fr;
  gap: 3px 8px;
  align-items: baseline;
}
.ni-fl {
  color: rgba(255,255,255,0.3);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.ni-fv {
  grid-column: 3;
  word-break: break-all;
  font-size: 12px;
  color: #c8cfe8;
}

.ni-url { color: #93c5fd !important; font-size: 11px; }
.ni-mono { font-family: "SF Mono","Fira Code",monospace; }
.ni-na { color: rgba(255,255,255,0.2); font-style: italic; font-size: 11px; }
.ni-err { color: #f87171; }
.ni-ok  { color: #4ade80; }
.ni-dim { color: rgba(255,255,255,0.3); }

/* Sections */
.ni-section {
  background: rgba(0,0,0,0.2);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px;
  overflow: hidden;
}
.ni-sh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px 5px 10px;
  background: rgba(255,255,255,0.03);
  border: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
  color: inherit;
  transition: background 0.12s;
}
.ni-sh:hover { background: rgba(255,255,255,0.06); }
.ni-section--open > .ni-sh { border-bottom: 1px solid rgba(255,255,255,0.05); }
.ni-sh-right { display: flex; align-items: center; gap: 6px; }
.ni-sl {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgba(255,255,255,0.35);
  flex: 1;
}
.ni-sec-chevron {
  color: rgba(255,255,255,0.2);
  transition: transform 0.18s;
  flex-shrink: 0;
}
.ni-section--open .ni-sec-chevron { transform: rotate(180deg); color: rgba(255,109,90,0.6); }
.ni-sb[hidden] { display: none !important; }
.ni-sb {
  display: block;
  padding: 7px 9px;
  overflow-x: auto;
  max-height: 260px;
  overflow-y: auto;
}
.ni-sb::-webkit-scrollbar { width: 3px; height: 3px; }
.ni-sb::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.ni-headers-list { display: flex; flex-direction: column; gap: 1px; }
.ni-hr {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-family: "SF Mono","Fira Code",monospace;
  font-size: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.ni-hn { white-space: nowrap; min-width: 120px; flex-shrink: 0; }
.ni-hv { color: #c8cfe8; word-break: break-all; }

/* Code block */
.ni-code {
  margin: 0;
  font-family: "SF Mono","Fira Code","Cascadia Code",monospace;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: #abb2bf;
  tab-size: 2;
}

/* ── Syntax tokens — One Dark palette ── */
.hl-key     { color: #e06c75; }            /* JSON keys            — soft red     */
.hl-str     { color: #98c379; }            /* strings              — green        */
.hl-num     { color: #d19a66; }            /* numbers              — orange       */
.hl-kw      { color: #56b6c2; }            /* true / false / null  — teal         */
.hl-brace   { color: rgba(255,255,255,0.5); }  /* { }               — muted white  */
.hl-bracket { color: #c678dd; }            /* [ ]                  — purple       */
.hl-colon   { color: rgba(255,255,255,0.3); }  /* :                 — dim          */
.hl-punct   { color: rgba(255,255,255,0.3); }  /* , < > /           — dim          */
.hl-tag     { color: #e06c75; }            /* XML tag names        — red          */
.hl-attr    { color: #d19a66; }            /* XML/header attr      — orange       */
.hl-comment { color: #5c6370; font-style: italic; }
.hl-pi      { color: #c678dd; }            /* processing instr     — purple       */
.hl-cdata   { color: #98c379; }

/* Copy button */
.ni-copy-btn {
  font-size: 9px;
  padding: 1px 6px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.35);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  white-space: nowrap;
  font-family: inherit;
}
.ni-copy-btn:hover {
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.85);
}

/* ── Toggle FAB ── */
#n8n-http-inspector-toggle {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483641;
  width: 38px;
  height: 38px;
  background: linear-gradient(135deg, #ff6d5a, #ff4d6d);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 20px rgba(255,109,90,0.5), 0 0 0 1px rgba(255,255,255,0.1);
  transition: transform 0.2s, box-shadow 0.2s;
}
#n8n-http-inspector-toggle:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 28px rgba(255,109,90,0.65), 0 0 0 1px rgba(255,255,255,0.15);
}
#n8n-http-inspector-toggle.ni-toggle--active {
  background: rgba(20, 20, 45, 0.9);
  backdrop-filter: blur(8px);
  box-shadow: 0 2px 12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
}
#n8n-http-inspector-toggle:focus-visible {
  outline: 2px solid #ff6d5a;
  outline-offset: 3px;
}

/* ── Action bar (cURL button row) ── */
.ni-action-bar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 2px;
}
.ni-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  padding: 3px 9px;
  background: rgba(147,197,253,0.1);
  border: 1px solid rgba(147,197,253,0.2);
  border-radius: 5px;
  color: #93c5fd;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  font-family: inherit;
  white-space: nowrap;
}
.ni-action-btn:hover {
  background: rgba(147,197,253,0.18);
  color: #bfdbfe;
}
.ni-action-btn--warn {
  background: rgba(251,191,36,0.08);
  border-color: rgba(251,191,36,0.2);
  color: #fbbf24;
}
.ni-action-btn--warn:hover { background: rgba(251,191,36,0.15); }

/* ── Diagnosis hint ── */
.ni-diagnosis {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ni-diagnosis--error {
  background: rgba(248,113,113,0.07);
  border: 1px solid rgba(248,113,113,0.2);
}
.ni-diagnosis--warn {
  background: rgba(251,191,36,0.07);
  border: 1px solid rgba(251,191,36,0.2);
}
.ni-diagnosis--info {
  background: rgba(96,165,250,0.07);
  border: 1px solid rgba(96,165,250,0.2);
}
.ni-diagnosis-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
}
.ni-diagnosis--error .ni-diagnosis-header { color: #f87171; }
.ni-diagnosis--warn  .ni-diagnosis-header { color: #fbbf24; }
.ni-diagnosis--info  .ni-diagnosis-header { color: #60a5fa; }
.ni-diagnosis-hint { color: rgba(255,255,255,0.6); margin: 0; }
.ni-diagnosis-fix { color: rgba(255,255,255,0.5); margin: 0; font-size: 10px; }
.ni-diagnosis-fix-label { font-weight: 700; color: rgba(255,255,255,0.4); }

/* ── Secret warning ── */
.ni-secret-warn {
  background: rgba(251,191,36,0.06);
  border: 1px solid rgba(251,191,36,0.22);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}
.ni-secret-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #fbbf24;
  font-weight: 700;
}
.ni-secret-hint {
  margin-left: auto;
  font-size: 9px;
  color: rgba(251,191,36,0.5);
  font-weight: 400;
}
.ni-secret-list {
  margin: 0;
  padding: 0 0 0 14px;
  color: rgba(255,255,255,0.45);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ni-secret-type { color: #fbbf24; font-weight: 600; }
.ni-secret-loc { color: rgba(255,255,255,0.4); }
.ni-secret-list code {
  font-family: "SF Mono","Fira Code",monospace;
  font-size: 10px;
  color: rgba(255,255,255,0.4);
}

/* ── Diff mode ── */
.ni-icon-btn--active {
  color: #ff6d5a !important;
  background: rgba(255,109,90,0.1) !important;
}

.ni-diff-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: rgba(255,109,90,0.04);
  border-top: 1px solid rgba(255,255,255,0.04);
  font-size: 11px;
  color: rgba(255,255,255,0.4);
}
.ni-diff-row[hidden] { display: none !important; }
.ni-diff-cb { accent-color: #ff6d5a; cursor: pointer; }
.ni-diff-lbl { cursor: pointer; }

.ni-diff-container {
  border-top: 2px solid rgba(255,109,90,0.3);
  overflow-y: auto;
  max-height: 50%;
  flex-shrink: 0;
}
.ni-diff-container[hidden] { display: none !important; }

.ni-diff-header {
  padding: 8px 10px 6px;
  background: rgba(255,109,90,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: sticky;
  top: 0;
  z-index: 2;
}
.ni-diff-title {
  font-size: 11px;
  font-weight: 700;
  color: #ff6d5a;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ni-diff-title em { font-style: normal; color: rgba(255,255,255,0.7); }
.ni-diff-identical {
  font-size: 9px;
  background: rgba(74,222,128,0.15);
  border: 1px solid rgba(74,222,128,0.25);
  color: #4ade80;
  border-radius: 4px;
  padding: 1px 6px;
  font-weight: 600;
}
.ni-diff-col-labels {
  display: grid;
  grid-template-columns: 80px 1fr 1fr;
  gap: 4px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.ni-diff-col-a { color: rgba(147,197,253,0.7); }
.ni-diff-col-b { color: rgba(196,181,253,0.7); }

.ni-diff-row-data {
  display: grid;
  grid-template-columns: 80px 1fr 1fr;
  gap: 4px;
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 11px;
  align-items: start;
}
.ni-diff-row-data:last-child { border-bottom: none; }
.ni-diff-unchanged { opacity: 0.4; }
.ni-diff-changed { background: rgba(251,191,36,0.04); }
.ni-diff-added   { background: rgba(74,222,128,0.04); }
.ni-diff-removed { background: rgba(248,113,113,0.04); }

.ni-diff-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(255,255,255,0.3);
  padding-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ni-diff-cell { overflow: hidden; }
.ni-diff-cell--a .ni-diff-val { color: #93c5fd; }
.ni-diff-cell--b .ni-diff-val { color: #c4b5fd; }
.ni-diff-val {
  margin: 0;
  font-family: "SF Mono","Fira Code",monospace;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}
`;

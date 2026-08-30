# n8n HTTP Inspector


<!-- TOC-START -->

## 📋 Table of Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
  - [Core](#core)
  - [v2 Features](#v2-features)
- [Setup](#setup)
  - [n8n Cloud (`*.app.n8n.cloud`)](#n8n-cloud-appn8ncloud)
  - [Self-hosted n8n](#self-hosted-n8n)
- [Usage](#usage)
  - [Panel controls](#panel-controls)
- [What data is available](#what-data-is-available)
  - [Always available](#always-available)
  - [Available from static node parameters](#available-from-static-node-parameters)
  - [Requires node settings to be enabled](#requires-node-settings-to-be-enabled)
  - [Error responses (4xx/5xx)](#error-responses-4xx5xx)
- [How it works](#how-it-works)
- [Installation (development)](#installation-development)
  - [Prerequisites](#prerequisites)
  - [Build](#build)
  - [Load unpacked](#load-unpacked)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)

<!-- TOC-END -->

A Chrome extension that surfaces HTTP Request node call details directly inside the n8n editor — request method, URL, headers, body, response status, response body, execution timing, and more. All the stuff n8n's built-in UI buries or omits.

**Current version:** 2.0.0

---

## Why this exists

n8n's HTTP Request nodes run **server-side**. The browser's DevTools Network tab will never show those calls. What the browser *does* see is n8n's frontend fetching execution result JSON from its own REST API after a run. This extension intercepts that response, decodes n8n's internal serialization format, parses out the HTTP Request node data, and renders it in a floating panel directly inside the n8n editor.

No data leaves your browser. No backend. No account required.

---

## Features

### Core
- **Floating panel** — draggable, resizable from all 8 edges/corners, position saved across navigation
- **Results stack** across executions — run a workflow 3 times and see all 3 runs labelled `#1`, `#2`, `#3`
- **Syntax-highlighted JSON and XML** — token-based One Dark colorscheme (keys, strings, numbers, booleans, tags, attributes)
- **Collapsible sections** — every field group (Request Headers, Request Body, Response Headers, Response Body) expands/collapses individually
- **Search / filter** — live filter across all captured calls by node name, URL, method, or status code
- **Clear all** button and `Alt+H` keyboard shortcut to toggle panel

### v2 Features

**Copy as cURL**  
One-click converts any captured call into a ready-to-paste `curl` command. Handles shell escaping, adds `Content-Type` hints for JSON bodies, and notes when values come from static node parameters rather than runtime-resolved expressions.

**Automatic error diagnosis**  
For every failed call, the panel surfaces a plain-English explanation and an n8n-specific fix. Examples:
- `401 Bearer Token` → "Check the token hasn't expired. Decode at jwt.io to confirm exp…"
- `429 Rate Limited` → reads your `Retry-After` header and tells you exactly how long to wait
- `ECONNREFUSED` → "Check the URL and port are correct, and that the server is running from your n8n host"
- Covers 20+ failure patterns: DNS failures, TLS errors, socket resets, 400/403/404/405/409/422/500/502/503/504, and more

**Cross-execution diff**  
Click the ⇄ icon to enter diff mode. Checkboxes appear on each card. Select any two runs — from the same execution or different ones — to see a side-by-side comparison of method, URL, status, duration, all request/response headers, and request/response body. JSON bodies are normalised before comparison so whitespace differences don't show as changes. Rows are colour-coded: changed (yellow), added (green), removed (red), unchanged (dimmed).

**Secret / token redaction warnings**  
Before you screenshot the panel to share in Discord or Reddit, the extension flags anything that looks like a credential:
- Authorization headers (Bearer, Basic)
- API key headers (`x-api-key`, `x-auth-token`, etc.)
- Known secret prefixes (`sk-`, `ghp_`, `xoxb-`, `ey…` JWTs, `ya29.` Google tokens, etc.)
- High-entropy strings in response bodies
A "Redact secrets in view" button replaces flagged values in-place so your screenshot is safe to share.

---

## Setup

### n8n Cloud (`*.app.n8n.cloud`)

Works automatically. Just install and run a workflow.

### Self-hosted n8n

1. Click the extension toolbar icon → **Settings** opens in a new tab
2. Enter your n8n instance URL (e.g. `https://n8n.mycompany.com` or `http://localhost:5678`)
3. Approve the Chrome permission prompt for that domain
4. Hard-refresh (`Cmd+Shift+R`) your n8n tab

---

## Usage

1. Open any workflow in the n8n editor
2. Click **Execute workflow** (or open a past execution from the Executions tab)
3. The inspector panel appears automatically — or toggle it with the **⚡ button** (bottom-right)
4. Each HTTP Request node run appears as a collapsible card
5. Expand a card to see URL, status, body, timing, and the cURL command

### Panel controls

| Control | Action |
|---|---|
| Drag header | Move the panel |
| Drag any edge/corner | Resize |
| ⇄ button | Toggle diff mode |
| 🗑 button | Clear all results |
| ✕ button | Close panel |
| `Alt+H` | Toggle panel open/closed |
| Search bar | Filter by name, URL, method, or status |

Results **stack across executions** — cleared only on a full page reload or by clicking the trash button.

---

## What data is available

This is the most important thing to understand.

### Always available

| Field | Notes |
|---|---|
| Response body | The output of the HTTP Request node — what n8n received and stored |
| Node name | As labelled in the workflow |
| Execution time | Per-node duration in ms |
| Execution status | `success`, `error`, etc. |

### Available from static node parameters

If you use hardcoded values (not expressions), the extension reads them from the saved node config:

| Field | Notes |
|---|---|
| Request method | GET, POST, PUT, etc. |
| Request URL | Static value only — `={{ expressions }}` show as their literal string |

### Requires node settings to be enabled

n8n's HTTP Request node does **not** include request/response metadata by default. To unlock:

| Field | Required setting |
|---|---|
| Response status code | **"Include Response Headers and Status"** in node options |
| Response headers | Same setting |
| Request headers actually sent | Not available in execution data — n8n does not store these server-side |
| Actual resolved request body | Not available in execution data |

> **Honest note:** n8n's execution API stores workflow *results*, not full HTTP traces. Request headers and the exact runtime-resolved body are not accessible via the execution endpoint. The extension shows everything that is actually present and labels missing fields clearly — it never fabricates data.

### Error responses (4xx/5xx)

When an HTTP Request node fails, n8n stores error details in `error.cause`. The extension extracts:
- The HTTP status code and message
- The error response body (from `error.cause.body`)
- The error description

---

## How it works

```
n8n editor page
      │
      │  fetch /rest/executions/{id}    ← also catches Executions tab history
      ▼
  n8n REST API  →  execution JSON
      │
      │  intercepted by main-world.js (MAIN world content script)
      │  patches window.fetch + XMLHttpRequest before n8n loads
      ▼
  CustomEvent dispatched on window
      │
      │  received by content.js (isolated content script)
      ▼
  parser.ts
    ├── decodes n8n's indexed serialization (data field is a JSON string,
    │   values reference each other by array index)
    ├── navigates to resultData.runData
    ├── filters for n8n-nodes-base.httpRequest nodes
    └── extracts response/error/timing per run
      │
      ▼
  panel-ui.ts  →  glassmorphism floating panel
  curl.ts      →  cURL command generation
  diagnosis.ts →  error pattern matching + hints
  diff.ts      →  two-run comparison engine
  redaction.ts →  secret detection + in-place redaction
```

The MAIN world content script (`main-world.content.ts`) runs at `document_start` so it patches `fetch` and `XHR` before n8n's own code loads. This avoids any CSP issues with inline script injection.

---

## Installation (development)

### Prerequisites
- Node.js 18+
- npm

### Build

```bash
cd n8n-http-inspector
npm install
npm run build
```

Output: `.output/chrome-mv3/`

### Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `.output/chrome-mv3/`
4. Hard-refresh any open n8n tab (`Cmd+Shift+R`)

> **Dev mode note:** `npm run dev` opens Chrome with hot-reload but n8n's CSP may block WXT's HMR bootstrap script. Use the production build for testing against a real n8n instance.

---

## Project structure

```
src/
├── entrypoints/
│   ├── content.ts              # Isolated world — routes intercepted events to parser → panel
│   ├── main-world.content.ts   # Main world — patches fetch + XHR (runs at document_start)
│   ├── background.ts           # Service worker — toolbar icon → opens settings
│   └── settings.html           # Settings page — domain registration UI
└── modules/
    ├── parser.ts               # Decodes n8n serialization → HttpNodeCall[]
    ├── panel-ui.ts             # Floating panel, glassmorphism CSS, token syntax highlighting
    ├── curl.ts                 # cURL command builder
    ├── diagnosis.ts            # Error pattern matching → plain-English hints
    ├── diff.ts                 # Two-run comparison engine
    ├── redaction.ts            # Secret/token detection and redaction
    ├── settings-page.ts        # Settings page script (domain management)
    └── interceptor.ts          # (legacy reference, superseded by main-world.content.ts)
```

---

## Known limitations

- **Request headers/body** — not available from n8n's execution API by default. The extension cannot show what was actually sent over the wire, only what n8n stored in execution output.
- **Expression-resolved URLs** — if your URL uses `={{ $json.endpoint }}`, the extension cannot resolve the expression and will show the literal string or nothing.
- **Large responses** — very large bodies may be truncated by n8n before storage. The extension shows whatever n8n kept.
- **n8n version compatibility** — confirmed against n8n's execution format as of 2026-08-30. If n8n changes its internal serialization format, `parser.ts` may need updates.
- **Self-hosted detection** — uses URL patterns and page title heuristics. Unusual reverse-proxy setups may not auto-detect — use the Settings page to register your domain manually.
- **cURL accuracy** — the generated cURL command reflects captured data. If request headers/body weren't available in execution output, the command will be incomplete (clearly noted in a comment at the top of the command).

---

## Roadmap

- [ ] Export to Postman collection format
- [ ] Firefox support
- [ ] Support for other node types (GraphQL, Webhook response)
- [ ] Request header capture via `chrome.devtools.network` API (alternative to execution data)

---

## License

MIT

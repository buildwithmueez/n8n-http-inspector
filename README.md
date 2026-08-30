# n8n HTTP Inspector

A Chrome extension that surfaces HTTP Request node call details directly inside the n8n editor — request method, URL, headers, body, response status, response body, and execution timing. All the stuff n8n's built-in UI buries or omits.

---

## Why this exists

n8n's HTTP Request nodes run **server-side**. The browser's DevTools Network tab won't show those calls. What the browser *does* see is n8n's frontend fetching execution result JSON from its own REST API after a run. This extension intercepts that response, parses out the HTTP Request node data, and renders it in a floating panel inside the n8n editor page.

No data leaves your browser. No backend. No account required.

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
3. The inspector panel appears automatically in the bottom-right corner
4. Each HTTP Request node run shows as a collapsible card
5. Toggle the panel anytime with the **⚡ button** (bottom-right) or `Alt+H`

### Panel controls

| Control | Action |
|---|---|
| Drag header | Move the panel |
| Drag any edge or corner | Resize |
| 🗑 button | Clear all accumulated results |
| ✕ button | Close panel |
| Search bar | Filter by node name, URL, method, or status code |
| `Alt+H` | Toggle panel open/closed |

Results **stack across executions** — running a workflow three times shows all three runs, labelled `#1`, `#2`, `#3`. The panel only resets on a full page reload.

---

## What data is available

This is the most important thing to understand before using the extension.

### Always available (no node configuration needed)

| Field | Notes |
|---|---|
| Node name | As labelled in the workflow |
| Execution time | Per-node duration in milliseconds |
| Execution status | `success`, `error`, etc. |
| Response body | The output items from the node — what n8n received |

### Available from static node parameters (not expression-resolved)

If you use hardcoded values (not `={{ $json.url }}` expressions), the extension reads these from the node's saved configuration:

| Field | Notes |
|---|---|
| Request method | GET, POST, PUT, etc. |
| Request URL | Only the static value — expressions show as the literal expression string |

### Available only with node settings enabled

n8n's HTTP Request node does **not** include request/response metadata in execution output by default. To unlock these fields:

| Field | Required setting |
|---|---|
| Response status code | Enable **"Include Response Headers and Status"** in the HTTP Request node |
| Response headers | Same setting |
| Request headers sent | Not available from execution data in current n8n versions |
| Request body sent | Not available from execution data in current n8n versions |

To enable: open the HTTP Request node → Options tab → turn on **"Include Response in Output"** and **"Include Response Headers and Status"**.

> **Honest note:** n8n's execution API was designed to store workflow *results*, not full HTTP debug traces. Request headers and the exact resolved request body are not stored server-side in a way the frontend can retrieve. The extension surfaces everything that is actually present in the execution data — it will never fabricate or guess values. Fields that aren't available are labelled clearly so you know what's missing and why.

### Error responses

When an HTTP Request node fails (network error, 4xx, 5xx):
- The error message is shown in a red banner
- If n8n stored the error response body (in `error.cause`), it is extracted and shown as "Error Response Body"
- HTTP status codes from failed requests are surfaced when available

---

## How it works

```
n8n editor page
      │
      │  fetch /rest/executions/{id}
      ▼
  n8n REST API  ──→  execution JSON (serialized)
      │
      │  (intercepted by main-world.js content script)
      ▼
  CustomEvent dispatched on window
      │
      │  (received by isolated content script)
      ▼
  parser.ts  ──→  decodes n8n's indexed serialization
                  ──→  finds httpRequest nodes in runData
                  ──→  extracts response/error/timing
      │
      ▼
  panel-ui.ts  ──→  renders glassmorphism floating panel
                    with syntax-highlighted JSON/XML
```

n8n uses an internal indexed serialization format for execution data — the `data` field is a JSON string where values reference each other by array index to avoid repetition. The parser decodes this before extracting node results.

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
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select `.output/chrome-mv3/`
4. Hard-refresh any open n8n tab

### Dev mode (hot reload)

```bash
npm run dev
```

Note: dev mode injects a WXT bootstrap script that n8n's CSP may block — use the production build for testing against a real n8n instance.

---

## Project structure

```
src/
├── entrypoints/
│   ├── content.ts           # Isolated world — mounts panel, routes events to parser
│   ├── main-world.content.ts # Main world — patches fetch + XHR to intercept API calls
│   ├── background.ts        # Service worker — toolbar icon → opens settings
│   └── settings.html        # Settings page — domain registration
├── modules/
│   ├── parser.ts            # Decodes n8n's serialized execution JSON → HttpNodeCall[]
│   ├── panel-ui.ts          # Panel DOM, glassmorphism CSS, syntax highlighting
│   ├── interceptor.ts       # (legacy, kept for reference)
│   └── settings-page.ts     # Settings page script
public/
└── icons/
```

---

## Known limitations

- **Request headers/body** are not available from n8n's execution API by default. The extension cannot show what was actually sent over the wire — only what n8n stored in the execution output.
- **Expression-resolved URLs** — if your HTTP Request node URL uses an expression like `={{ $json.endpoint }}`, the extension cannot resolve the expression. It will show the static fallback from node parameters, or nothing.
- **Large response bodies** — very large responses may be truncated by n8n before storage. The extension shows whatever n8n stored.
- **n8n version compatibility** — tested against n8n's current execution JSON format (confirmed 2026-08-30). If n8n changes its internal serialization format, `parser.ts` may need updates.
- **Self-hosted detection** — the extension uses URL patterns and page title to detect n8n pages. Unusual reverse-proxy setups may not be auto-detected — use the Settings page to manually register your domain.

---

## Roadmap

- [ ] Export to Postman collection format
- [ ] Diff two executions side by side
- [ ] Support for other node types (GraphQL, Webhook)
- [ ] Firefox support
- [ ] Request headers via devtools panel API (as an alternative to execution data)

---

## License

MIT

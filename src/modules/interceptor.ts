/**
 * interceptor.ts
 *
 * Intercepts n8n's internal REST API calls to fetch execution data.
 * This code is injected into the PAGE context (not the extension context)
 * so it can monkey-patch the page's own fetch/XHR.
 *
 * It posts a custom window event with the execution JSON whenever it detects
 * a response from n8n's execution detail endpoint. The content script listens
 * for this event and forwards it to the panel.
 *
 * Why window events? The injected page script and content script live in
 * separate JS worlds — postMessage via window events is the bridge.
 */

export const INTERCEPTOR_EVENT = "n8n-inspector:execution-data";
export const NO_HTTP_NODES_EVENT = "n8n-inspector:no-http-nodes";

/**
 * This function is serialised and injected into the page via a <script> tag.
 * It MUST be self-contained — no imports, no closure over extension globals.
 */
export function buildInterceptorScript(eventName: string): string {
  return `
(function() {
  'use strict';

  const EVENT_NAME = ${JSON.stringify(eventName)};

  // Patterns that match n8n's execution detail API endpoints.
  // n8n Cloud:    /rest/executions/{id}  OR  /api/v1/executions/{id}
  // Self-hosted:  /rest/executions/{id}
  // We match any URL path segment that looks like: /executions/<numeric-or-uuid-id>
  // and is NOT the list endpoint (no trailing slash before end or query string = single item).
  const EXECUTION_URL_RE = /\/executions\/([a-zA-Z0-9_-]+)(\?|$)/;

  function isExecutionDetailUrl(url) {
    return EXECUTION_URL_RE.test(url);
  }

  function dispatch(data) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: data }));
  }

  // ------------------------------------------------------------------
  // Patch fetch
  // ------------------------------------------------------------------
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await _origFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0]
                : args[0] instanceof Request ? args[0].url
                : String(args[0]);

      if (isExecutionDetailUrl(url)) {
        // Clone so the original response stream is not consumed
        const clone = response.clone();
        clone.json().then(data => {
          dispatch({ url, data });
        }).catch(() => {
          // Not JSON or parse error — ignore
        });
      }
    } catch (e) {
      // Never break the page's fetch
    }

    return response;
  };

  // ------------------------------------------------------------------
  // Patch XMLHttpRequest
  // ------------------------------------------------------------------
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._n8nInspectorUrl = url;
    return _origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        if (isExecutionDetailUrl(this._n8nInspectorUrl || '')) {
          const data = JSON.parse(this.responseText);
          dispatch({ url: this._n8nInspectorUrl, data });
        }
      } catch (e) {
        // Not JSON or not an execution endpoint — ignore
      }
    });
    return _origSend.apply(this, args);
  };

  console.debug('[n8n HTTP Inspector] Network interceptor active.');
})();
  `.trim();
}

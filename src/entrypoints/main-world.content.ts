/**
 * content-main.ts — WXT content script in the MAIN (page) world
 *
 * Runs directly in the page's JS context — same world as n8n's own code.
 * This means we can patch window.fetch and XMLHttpRequest without any
 * inline <script> injection (which n8n's CSP would block).
 *
 * When it detects a response from n8n's execution API it dispatches a
 * CustomEvent on window. The isolated content script (content.ts) picks
 * it up and drives the panel UI.
 */

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start", // patch fetch BEFORE n8n boots

  main() {
    const INTERCEPTOR_EVENT = "n8n-inspector:execution-data";

    // Match n8n's execution detail endpoint:
    //   /rest/executions/123
    //   /rest/executions/123?includeData=true
    //   /api/v1/executions/123
    // Must NOT match the list endpoint /rest/executions (no id segment after it)
    const EXECUTION_URL_RE = /\/executions\/([a-zA-Z0-9_-]+)/;

    function isExecutionDetailUrl(url: string): boolean {
      return EXECUTION_URL_RE.test(url);
    }

    function dispatch(url: string, data: unknown) {
      window.dispatchEvent(
        new CustomEvent(INTERCEPTOR_EVENT, { detail: { url, data } })
      );
    }

    // -----------------------------------------------------------------------
    // Patch fetch
    // -----------------------------------------------------------------------
    const _origFetch = window.fetch.bind(window);

    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const response = await _origFetch(...args);

      try {
        const input = args[0];
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
            ? input.url
            : String(input);

        if (isExecutionDetailUrl(url)) {
          response
            .clone()
            .json()
            .then((data: unknown) => dispatch(url, data))
            .catch(() => {/* not JSON */});
        }
      } catch {
        // never break page fetch
      }

      return response;
    };

    // -----------------------------------------------------------------------
    // Patch XMLHttpRequest
    // n8n's frontend may use axios under the hood, which uses XHR in browsers.
    // -----------------------------------------------------------------------
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      (this as XMLHttpRequest & { _n8nUrl?: string })._n8nUrl =
        typeof url === "string" ? url : url.toString();
      return (_origOpen as Function).apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args: unknown[]) {
      this.addEventListener("load", function () {
        const self = this as XMLHttpRequest & { _n8nUrl?: string };
        try {
          if (isExecutionDetailUrl(self._n8nUrl ?? "")) {
            const data = JSON.parse(self.responseText);
            dispatch(self._n8nUrl!, data);
          }
        } catch {
          // not JSON or wrong endpoint
        }
      });
      return (_origSend as Function).apply(this, args);
    };

    console.debug("[n8n HTTP Inspector] Main-world interceptor active — fetch + XHR patched.");
  },
});

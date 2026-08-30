/**
 * diagnosis.ts — Pattern-match common HTTP failure signatures and return
 * plain-English hints. n8n shows raw status codes; we interpret them.
 */

import type { HttpNodeCall } from "./parser";

export interface Diagnosis {
  /** Short label, e.g. "Rate Limited" */
  label: string;
  /** One-sentence explanation */
  hint: string;
  /** Suggested fix for n8n context */
  fix: string;
  /** Severity: warn (yellow) | error (red) | info (blue) */
  severity: "warn" | "error" | "info";
}

export function diagnose(call: HttpNodeCall): Diagnosis | null {
  const code = call.statusCode;
  const err = (call.error ?? "").toLowerCase();
  const body = bodyString(call.responseBody).toLowerCase();
  const url = (call.url ?? "").toLowerCase();

  // ── Network / connection errors (no status code) ──────────────────────────
  if (!code && call.error) {
    if (err.includes("econnrefused") || err.includes("connection refused"))
      return { label: "Connection Refused", severity: "error",
        hint: "The target server actively refused the connection.",
        fix: "Check the URL and port are correct, and that the server is running and reachable from your n8n host." };

    if (err.includes("etimedout") || err.includes("timed out") || err.includes("timeout"))
      return { label: "Timeout", severity: "error",
        hint: "The request timed out before the server responded.",
        fix: "Increase the timeout in the HTTP Request node options, or check if the endpoint is slow under load." };

    if (err.includes("enotfound") || err.includes("getaddrinfo") || err.includes("dns"))
      return { label: "DNS Failure", severity: "error",
        hint: "The hostname could not be resolved.",
        fix: "Verify the URL domain is spelled correctly and that your n8n host has DNS access." };

    if (err.includes("cert") || err.includes("ssl") || err.includes("tls") || err.includes("certificate"))
      return { label: "SSL/TLS Error", severity: "error",
        hint: "The SSL certificate could not be verified.",
        fix: 'For self-signed certs, toggle "Ignore SSL Issues" in the HTTP Request node. For production, ensure the cert chain is valid.' };

    if (err.includes("econnreset") || err.includes("socket hang up"))
      return { label: "Connection Reset", severity: "error",
        hint: "The server closed the connection unexpectedly mid-request.",
        fix: "This often means a proxy, load balancer, or the server itself dropped the connection. Check server logs." };

    return null;
  }

  if (!code) return null;

  // ── 4xx Client Errors ─────────────────────────────────────────────────────
  if (code === 400)
    return { label: "Bad Request", severity: "error",
      hint: "The server rejected the request as malformed.",
      fix: "Check request body shape and required fields match what the API expects. Look at the error response body for field-level validation messages." };

  if (code === 401) {
    const isBearer = hasHeader(call.requestHeaders, "authorization") &&
      (getHeader(call.requestHeaders, "authorization") ?? "").toLowerCase().startsWith("bearer");
    const isBasic = hasHeader(call.requestHeaders, "authorization") &&
      (getHeader(call.requestHeaders, "authorization") ?? "").toLowerCase().startsWith("basic");
    if (isBearer)
      return { label: "Unauthorized — Bearer Token", severity: "error",
        hint: "Your Bearer token was rejected.",
        fix: "Check the token hasn't expired. If it's a JWT, decode it at jwt.io to confirm exp. Consider adding a refresh-token flow before this node." };
    if (isBasic)
      return { label: "Unauthorized — Basic Auth", severity: "error",
        hint: "Basic auth credentials were rejected.",
        fix: "Verify username and password are correct and base64-encoded properly. Some APIs require the API key as the username with an empty password." };
    return { label: "Unauthorized", severity: "error",
      hint: "The server requires authentication but none was provided or it was invalid.",
      fix: 'Add credentials in the HTTP Request node Authentication section, or pass them via a header using "Header Auth".' };
  }

  if (code === 403) {
    if (body.includes("quota") || body.includes("limit exceeded"))
      return { label: "Forbidden — Quota Exceeded", severity: "error",
        hint: "You've hit a usage quota on this API.",
        fix: "Check your API plan limits. You may need to upgrade or reduce request frequency." };
    return { label: "Forbidden", severity: "error",
      hint: "Authenticated but not permitted to access this resource.",
      fix: "Check that the API key/token has the correct scopes/permissions. Some APIs require explicit scope grants (e.g. OAuth)." };
  }

  if (code === 404)
    return { label: "Not Found", severity: "warn",
      hint: "The resource at this URL does not exist.",
      fix: "Double-check the endpoint path and any dynamic ID segments. The resource may have been deleted, or the URL may be using a wrong environment (staging vs prod)." };

  if (code === 405)
    return { label: "Method Not Allowed", severity: "warn",
      hint: `The server does not accept ${call.method ?? "this method"} on this endpoint.`,
      fix: "Check the API docs for the correct HTTP method. A common mistake is using GET where POST is required." };

  if (code === 409)
    return { label: "Conflict", severity: "warn",
      hint: "The request conflicts with the current state of the resource.",
      fix: "This often means a duplicate resource (e.g. already exists). Check if the resource was already created and handle idempotency." };

  if (code === 410)
    return { label: "Gone", severity: "warn",
      hint: "This resource has been permanently removed.",
      fix: "Update your workflow to use the new endpoint or stop calling this one." };

  if (code === 422)
    return { label: "Unprocessable Entity", severity: "error",
      hint: "The request was well-formed but failed semantic validation.",
      fix: "Read the error response body carefully — it usually contains field-level validation errors. Fix the payload to match the API's schema." };

  if (code === 429) {
    const retryAfter = getHeader(call.responseHeaders, "retry-after");
    const resetAt = getHeader(call.responseHeaders, "x-ratelimit-reset");
    let fix = "Add a Wait node before this HTTP Request node to introduce a delay. Consider splitting large batches with a Loop node.";
    if (retryAfter) fix = `Server says wait ${retryAfter}s before retrying. Add a Wait node set to ${retryAfter} seconds. ${fix}`;
    else if (resetAt) fix = `Rate limit resets at ${resetAt}. ${fix}`;
    return { label: "Rate Limited", severity: "warn",
      hint: "You've sent too many requests in a short window.",
      fix };
  }

  if (code === 451)
    return { label: "Unavailable For Legal Reasons", severity: "info",
      hint: "Access to this resource is restricted for legal reasons (geo-block or GDPR).",
      fix: "Check if the API is geo-restricted and whether your n8n host's IP/region is allowed." };

  // ── 5xx Server Errors ─────────────────────────────────────────────────────
  if (code === 500) {
    if (body.includes("database") || body.includes("db error") || body.includes("sql"))
      return { label: "Server Error — DB Issue", severity: "error",
        hint: "The server returned a 500, and the response mentions a database error.",
        fix: "This is an issue on the API server side. Check if the API has a status page. If self-hosted, check your database." };
    return { label: "Internal Server Error", severity: "error",
      hint: "The API server crashed while handling your request.",
      fix: "Not your fault — check the API status page. If this is a self-hosted API, check its error logs." };
  }

  if (code === 502)
    return { label: "Bad Gateway", severity: "error",
      hint: "A proxy or load balancer received an invalid response from the upstream server.",
      fix: "Often transient — add a retry with exponential backoff. If persistent, the upstream service may be down." };

  if (code === 503)
    return { label: "Service Unavailable", severity: "error",
      hint: "The server is temporarily unable to handle requests (overloaded or in maintenance).",
      fix: "Add a retry node with backoff. Check the API's status page. If deploying self-hosted, check server resources." };

  if (code === 504)
    return { label: "Gateway Timeout", severity: "error",
      hint: "A proxy timed out waiting for the upstream server.",
      fix: "The downstream API is too slow. Increase timeout in HTTP Request node, or check if the request payload is unusually large." };

  // ── 2xx with hints ────────────────────────────────────────────────────────
  if (code === 204)
    return { label: "No Content", severity: "info",
      hint: "Request succeeded but the server returned no body.",
      fix: "This is normal for DELETE or certain POST operations. If you expected a response body, check the API docs." };

  // ── URL pattern hints ─────────────────────────────────────────────────────
  if (code && code >= 400 && url.includes("localhost"))
    return { label: `${code} — Localhost URL`, severity: "warn",
      hint: "You're calling localhost from n8n.",
      fix: "n8n cloud can't reach your local machine. Use a tunnel (ngrok, Cloudflare Tunnel) or deploy the service to a reachable host." };

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyString(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  try { return JSON.stringify(body); } catch { return ""; }
}

function hasHeader(headers: Record<string, string> | null, name: string): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

function getHeader(headers: Record<string, string> | null, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

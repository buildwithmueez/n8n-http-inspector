/**
 * redaction.ts — Detect likely secrets/tokens in captured data.
 *
 * Philosophy: high precision over high recall. A missed secret is better
 * than flooding the UI with false positives on standard HTTP headers.
 *
 * Detection approach (in order of confidence):
 *  1. Header name allowlist — only flag headers whose names are known
 *     secret carriers (Authorization, x-api-key, cookie, etc.)
 *  2. Known value prefixes — Bearer, Basic, sk-, ghp_, xoxb-, ey (JWT), etc.
 *  3. Body scan — only for explicit secret prefixes, NOT raw entropy
 *
 * We deliberately do NOT flag:
 *  - Standard HTTP response headers (date, content-type, server, etag,
 *    nel, report-to, strict-transport-security, server-timing, etc.)
 *  - High-entropy strings without a known prefix — too many false positives
 *    (UUIDs, base64-encoded images, cache keys, nonces all look "high entropy")
 */

export interface RedactionFinding {
  type: string;
  location: string;
  preview: string;
}

// ---------------------------------------------------------------------------
// Header names that are KNOWN secret carriers
// Deliberately narrow — does NOT include common infra headers
// ---------------------------------------------------------------------------
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "api_key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-secret-key",
  "x-secret",
  "x-token",
  "x-api-token",
  "x-amz-security-token",
  "x-amz-access-token",
  "cookie",
  "set-cookie",
]);

// Headers that look long/complex but are NEVER secrets — skip value checks
const SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "date",
  "server",
  "etag",
  "last-modified",
  "expires",
  "cache-control",
  "pragma",
  "vary",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "nel",
  "report-to",
  "server-timing",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "x-xss-protection",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "timing-allow-origin",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "origin",
  "referer",
  "host",
  "location",
  "age",
  "alt-svc",
  "cf-ray",
  "cf-cache-status",
  "x-request-id",
  "x-correlation-id",
  "x-response-time",
  "x-powered-by",
  "x-runtime",
]);

// ---------------------------------------------------------------------------
// Known secret value prefixes — high precision
// ---------------------------------------------------------------------------
const SECRET_PREFIXES: Array<{ prefix: string; type: string }> = [
  { prefix: "bearer ",    type: "Bearer token" },
  { prefix: "basic ",     type: "Basic auth credential" },
  { prefix: "token ",     type: "Token credential" },
  { prefix: "apikey ",    type: "API key" },
  { prefix: "sk-",        type: "OpenAI / Stripe secret key" },
  { prefix: "pk_live_",   type: "Stripe live publishable key" },
  { prefix: "sk_live_",   type: "Stripe live secret key" },
  { prefix: "rk_live_",   type: "Stripe restricted key" },
  { prefix: "ghp_",       type: "GitHub personal access token" },
  { prefix: "gho_",       type: "GitHub OAuth token" },
  { prefix: "ghu_",       type: "GitHub user token" },
  { prefix: "ghs_",       type: "GitHub server token" },
  { prefix: "xoxb-",      type: "Slack bot token" },
  { prefix: "xoxp-",      type: "Slack user token" },
  { prefix: "xoxa-",      type: "Slack app-level token" },
  { prefix: "eyj",        type: "JWT (starts with base64-encoded header)" },
  { prefix: "ya29.",      type: "Google OAuth access token" },
  { prefix: "aiza",       type: "Google API key" },
];

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export function scanHeaders(
  headers: Record<string, string>,
  location: string
): RedactionFinding[] {
  const findings: RedactionFinding[] = [];

  for (const [name, value] of Object.entries(headers)) {
    const nameLower = name.toLowerCase();

    // Skip headers that are structurally never secrets
    if (SAFE_HEADERS.has(nameLower)) continue;

    // Flag by header name
    if (SECRET_HEADER_NAMES.has(nameLower)) {
      findings.push({
        type: secretTypeFromHeaderName(nameLower),
        location: `${location} → ${name}`,
        preview: previewString(value),
      });
      continue;
    }

    // Flag by value prefix (applies to custom headers like x-my-app-token)
    const valueLower = value.toLowerCase();
    const prefixMatch = SECRET_PREFIXES.find((p) => valueLower.startsWith(p.prefix));
    if (prefixMatch) {
      findings.push({
        type: prefixMatch.type,
        location: `${location} → ${name}`,
        preview: previewString(value),
      });
    }
    // No raw entropy check on header values — too many false positives
  }

  return findings;
}

/**
 * Scan a response body for secrets.
 * Only flags values matching a known prefix pattern — no raw entropy scoring.
 * This avoids flagging UUIDs, timestamps, base64 content, cache tokens, etc.
 */
export function scanBody(body: string, location: string): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  const seen = new Set<string>();

  for (const { prefix, type } of SECRET_PREFIXES) {
    // Build a regex that finds the prefix followed by enough chars to be a real token
    const escaped = escapeRe(prefix);
    // Require at least 20 chars after the prefix (filters out very short coincidental matches)
    const re = new RegExp(`${escaped}[A-Za-z0-9_\\-./+=]{20,}`, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const found = match[0];
      if (seen.has(found)) continue;
      seen.add(found);
      findings.push({
        type,
        location,
        preview: previewString(found),
      });
    }
  }

  return findings;
}

/** Redact secrets in a string — only replaces known-prefix patterns */
export function redactString(input: string): string {
  let out = input;
  for (const { prefix } of SECRET_PREFIXES) {
    const re = new RegExp(`(${escapeRe(prefix)})[A-Za-z0-9_\\-./+=]{8,}`, "gi");
    out = out.replace(re, (_, p) => `${p}***REDACTED***`);
  }
  return out;
}

export function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADER_NAMES.has(k.toLowerCase())) {
      out[k] = "***REDACTED***";
    } else {
      out[k] = redactString(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secretTypeFromHeaderName(name: string): string {
  if (name === "authorization" || name === "proxy-authorization") return "Authorization credential";
  if (name.includes("api-key") || name.includes("api_key") || name === "apikey") return "API key";
  if (name.includes("token") || name.includes("access")) return "Auth token";
  if (name === "cookie" || name === "set-cookie") return "Session cookie";
  if (name.includes("secret")) return "Secret key";
  return "Sensitive header value";
}

function previewString(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 8) return "****";
  const head = trimmed.slice(0, 6);
  const tail = trimmed.slice(-4);
  return `${head}…${tail} (${trimmed.length} chars)`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

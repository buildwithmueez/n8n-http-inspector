/**
 * redaction.ts — Detect likely secrets/tokens in captured data and
 * provide a redacted copy safe for sharing in Discord/Reddit/GitHub issues.
 *
 * Detection heuristics (all pattern-based, no network calls):
 *  - Authorization: Bearer <token> / Basic <base64>
 *  - x-api-key, api-key, api_key, apikey header values
 *  - High-entropy strings (≥24 chars of base62/base64 chars)
 *  - Known prefixes: sk-, pk_, ghp_, xoxb-, EAAx, AIza, ya29., etc.
 */

export interface RedactionResult {
  /** Whether any secrets were found */
  hasSecrets: boolean;
  /** List of what was found (for the warning message) */
  findings: RedactionFinding[];
  /** Redacted version of the input */
  redacted: string;
}

export interface RedactionFinding {
  type: string;    // e.g. "Bearer token", "API key header", "High-entropy string"
  location: string; // e.g. "Authorization header", "response body"
  preview: string;  // first 4 + last 4 chars, rest as ***
}

// Header names that typically carry secrets
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key", "api-key", "api_key", "apikey",
  "x-auth-token", "x-access-token", "x-secret-key",
  "x-token", "token",
  "proxy-authorization",
  "cookie", "set-cookie",
  "x-amz-security-token", "x-amz-access-token",
]);

// Known secret prefixes (value-level detection)
const SECRET_PREFIXES = [
  { prefix: "bearer ", type: "Bearer token" },
  { prefix: "basic ", type: "Basic auth credential" },
  { prefix: "sk-", type: "OpenAI / Stripe secret key" },
  { prefix: "pk_", type: "Stripe publishable key" },
  { prefix: "ghp_", type: "GitHub personal access token" },
  { prefix: "gho_", type: "GitHub OAuth token" },
  { prefix: "ghu_", type: "GitHub user token" },
  { prefix: "ghs_", type: "GitHub server-to-server token" },
  { prefix: "xoxb-", type: "Slack bot token" },
  { prefix: "xoxp-", type: "Slack user token" },
  { prefix: "xoxa-", type: "Slack app-level token" },
  { prefix: "ey", type: "JWT (base64 header starts with ey)" },
  { prefix: "ya29.", type: "Google OAuth access token" },
  { prefix: "aiza", type: "Google API key" },
  { prefix: "eaax", type: "Facebook/Meta access token" },
];

// High-entropy string: ≥28 chars of base62+_-. chars
// Tuned to avoid URLs and normal prose
const HIGH_ENTROPY_RE = /\b[A-Za-z0-9_\-./+]{28,}\b/g;

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

    if (SECRET_HEADER_NAMES.has(nameLower)) {
      findings.push({
        type: secretTypeFromHeaderName(nameLower),
        location: `${location} → ${name}`,
        preview: previewString(value),
      });
      continue;
    }

    // Check value for known prefixes
    const prefixMatch = SECRET_PREFIXES.find((p) =>
      value.toLowerCase().startsWith(p.prefix)
    );
    if (prefixMatch) {
      findings.push({
        type: prefixMatch.type,
        location: `${location} → ${name}`,
        preview: previewString(value),
      });
      continue;
    }

    // High-entropy value in non-obvious header
    if (looksHighEntropy(value)) {
      findings.push({
        type: "High-entropy value (possible secret)",
        location: `${location} → ${name}`,
        preview: previewString(value),
      });
    }
  }

  return findings;
}

export function scanBody(body: string, location: string): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  const matches = body.match(HIGH_ENTROPY_RE) ?? [];

  const seen = new Set<string>();
  for (const match of matches) {
    // Skip URLs, base64 images, and short hashes
    if (match.startsWith("http") || match.includes("/") && match.length < 40) continue;
    if (seen.has(match)) continue;
    seen.add(match);

    // Only flag if it looks like a real secret (not a UUID or hex hash)
    if (looksLikeSecret(match)) {
      findings.push({
        type: "High-entropy string (possible API key/token)",
        location,
        preview: previewString(match),
      });
    }
  }

  return findings;
}

/** Redact secrets in a string for safe display */
export function redactString(input: string): string {
  let out = input;

  // Redact known prefix patterns
  for (const { prefix } of SECRET_PREFIXES) {
    const re = new RegExp(`(${escapeRe(prefix)})[A-Za-z0-9_\\-./+=]{8,}`, "gi");
    out = out.replace(re, (_, p) => p + "***REDACTED***");
  }

  // Redact high-entropy standalone tokens
  out = out.replace(HIGH_ENTROPY_RE, (match) => {
    if (looksLikeSecret(match)) return previewString(match, true);
    return match;
  });

  return out;
}

export function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const nameLower = k.toLowerCase();
    if (SECRET_HEADER_NAMES.has(nameLower)) {
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

function looksHighEntropy(s: string): boolean {
  if (s.length < 24) return false;
  // Count unique chars — real secrets have high diversity
  const unique = new Set(s.split("")).size;
  return unique > 12;
}

function looksLikeSecret(s: string): boolean {
  if (s.length < 24) return false;
  // Reject if it looks like a plain URL path segment or hex color
  if (/^[0-9a-f]{6,8}$/i.test(s)) return false; // hex color/hash
  if (/^\d+$/.test(s)) return false; // pure number
  // Must have mixed case or alphanumeric variety
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /\d/.test(s);
  return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower));
}

function secretTypeFromHeaderName(name: string): string {
  if (name === "authorization") return "Authorization credential";
  if (name.includes("api-key") || name.includes("api_key") || name === "apikey") return "API key";
  if (name.includes("token")) return "Auth token";
  if (name === "cookie" || name === "set-cookie") return "Session cookie";
  return "Sensitive header value";
}

function previewString(s: string, forRedact = false): string {
  if (s.length <= 8) return forRedact ? "***" : "****";
  const head = s.slice(0, 4);
  const tail = s.slice(-4);
  return forRedact ? `${head}***${tail}` : `${head}…${tail} (${s.length} chars)`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

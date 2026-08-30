/**
 * curl.ts — Generate a copy-paste curl command from a captured HTTP call.
 *
 * Body handling:
 *  - If $request meta is present (runtime data): use verbatim
 *  - If body comes from node parameters: parser.ts has already converted
 *    n8n's bodyParameters [{name,value}] pairs to a flat JSON object,
 *    so we can serialize that directly
 *  - Content-Type is inferred from the body shape when not explicitly set
 */

import type { HttpNodeCall } from "./parser";

export function buildCurlCommand(call: HttpNodeCall): string {
  const lines: string[] = [];

  const method = call.method?.toUpperCase() ?? "GET";
  const url = call.url ?? "<URL not captured>";

  // Normalise content-type lookup (headers may have any casing)
  const ctKey = call.requestHeaders
    ? Object.keys(call.requestHeaders).find((k) => k.toLowerCase() === "content-type")
    : undefined;
  const contentType = ctKey ? call.requestHeaders![ctKey] : undefined;

  lines.push(`curl -X ${method} \\`);
  lines.push(`  '${esc(url)}' \\`);

  // Headers — emit explicit content-type first if not already in the map
  let addedContentType = false;
  if (call.requestHeaders) {
    for (const [k, v] of Object.entries(call.requestHeaders)) {
      lines.push(`  -H '${esc(k)}: ${esc(v)}' \\`);
      if (k.toLowerCase() === "content-type") addedContentType = true;
    }
  }

  // Body
  if (call.requestBody) {
    const trimmed = call.requestBody.trim();
    const bodyIsJson = isJson(trimmed);

    // Add Content-Type if missing and body is JSON
    if (!addedContentType && bodyIsJson && !contentType) {
      lines.push(`  -H 'Content-Type: application/json' \\`);
    }

    lines.push(`  --data-raw '${esc(trimmed)}' \\`);
  }

  // Remove trailing backslash
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(" \\") ? last.slice(0, -2) : last;

  let cmd = lines.join("\n");

  // Caveat when data is from static node params (not runtime-captured)
  const fromStaticParams = !call.requestHeaders;
  if (fromStaticParams) {
    cmd =
      "# Note: body/headers come from static node parameters.\n" +
      "# Runtime-resolved expressions (={{ ... }}) will differ.\n" +
      cmd;
  }

  return cmd;
}

function isJson(s: string): boolean {
  if (!s.startsWith("{") && !s.startsWith("[")) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

function esc(s: string): string {
  // Shell single-quote escaping: ' → '\''
  return s.replace(/'/g, `'\\''`);
}

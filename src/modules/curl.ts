/**
 * curl.ts — Generate a copy-paste curl command from a captured HTTP call.
 *
 * Uses whatever data we have: method, url, headers, body.
 * When data is from node parameters (not $request meta) we add a comment
 * noting that headers/body may not reflect runtime-resolved values.
 */

import type { HttpNodeCall } from "./parser";

export function buildCurlCommand(call: HttpNodeCall): string {
  const lines: string[] = [];

  const method = call.method?.toUpperCase() ?? "GET";
  const url = call.url ?? "<URL not captured>";

  // Opening line
  lines.push(`curl -X ${method} \\`);
  lines.push(`  '${escapeSingleQuote(url)}' \\`);

  // Headers
  if (call.requestHeaders) {
    for (const [k, v] of Object.entries(call.requestHeaders)) {
      lines.push(`  -H '${escapeSingleQuote(k)}: ${escapeSingleQuote(v)}' \\`);
    }
  }

  // Body
  if (call.requestBody) {
    const trimmed = call.requestBody.trim();
    // Detect if JSON so we can set content-type hint
    const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (isJson && !call.requestHeaders?.["content-type"] && !call.requestHeaders?.["Content-Type"]) {
      lines.push(`  -H 'Content-Type: application/json' \\`);
    }
    // Use --data-raw to avoid @ interpretation
    lines.push(`  --data-raw '${escapeSingleQuote(trimmed)}' \\`);
  }

  // Remove trailing backslash from last line
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(" \\") ? last.slice(0, -2) : last;

  let cmd = lines.join("\n");

  // Add caveat comment when we only have static node params
  const hasRuntimeData = !!(call.requestHeaders || call.requestBody);
  const fromStaticParams = !hasRuntimeData && !!(call.method || call.url);
  if (fromStaticParams || !call.requestHeaders) {
    cmd =
      "# Note: request headers/body come from node parameters.\n" +
      "# Runtime-resolved expressions may differ.\n" +
      cmd;
  }

  return cmd;
}

function escapeSingleQuote(s: string): string {
  // In shell single-quoted strings, ' must be replaced with '\''
  return s.replace(/'/g, `'\\''`);
}

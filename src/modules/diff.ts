/**
 * diff.ts — Compare two HttpNodeCall runs of the same node side by side.
 *
 * Produces a structured diff: changed / added / removed / unchanged fields.
 * The panel renders this as a two-column view.
 */

import type { HttpNodeCall } from "./parser";

export type DiffStatus = "changed" | "added" | "removed" | "unchanged";

export interface DiffField {
  label: string;
  status: DiffStatus;
  left: string;   // execA value (or empty)
  right: string;  // execB value (or empty)
}

export interface CallDiff {
  nodeNameA: string;
  nodeNameB: string;
  execIdA: number;
  execIdB: number;
  fields: DiffField[];
  /** true when zero fields differ */
  identical: boolean;
}

export function diffCalls(
  a: HttpNodeCall & { execId: number },
  b: HttpNodeCall & { execId: number }
): CallDiff {
  const fields: DiffField[] = [];

  // ── Scalar fields ──────────────────────────────────────────────────────────
  fields.push(scalar("Method",   a.method,         b.method));
  fields.push(scalar("URL",      a.url,             b.url));
  fields.push(scalar("Status",   fmtStatus(a),      fmtStatus(b)));
  fields.push(scalar("Duration", fmtMs(a.executionTimeMs), fmtMs(b.executionTimeMs)));

  // ── Headers (request) ─────────────────────────────────────────────────────
  for (const f of diffHeaders("Req Header", a.requestHeaders, b.requestHeaders)) {
    fields.push(f);
  }

  // ── Request body ──────────────────────────────────────────────────────────
  fields.push(scalar("Request Body", normalizeBody(a.requestBody), normalizeBody(b.requestBody)));

  // ── Headers (response) ────────────────────────────────────────────────────
  for (const f of diffHeaders("Res Header", a.responseHeaders, b.responseHeaders)) {
    fields.push(f);
  }

  // ── Response body ─────────────────────────────────────────────────────────
  fields.push(bodyDiff(a.responseBody, b.responseBody));

  // ── Errors ────────────────────────────────────────────────────────────────
  if (a.error || b.error) {
    fields.push(scalar("Error", a.error ?? "", b.error ?? ""));
  }

  // For cleaner display, always include key fields even if unchanged
  const KEY_LABELS = new Set(["Method", "URL", "Status", "Duration"]);
  const shown = fields.filter(
    (f) => KEY_LABELS.has(f.label) || f.status !== "unchanged"
  );

  const identical = shown.every((f) => f.status === "unchanged");

  return {
    nodeNameA: a.nodeName,
    nodeNameB: b.nodeName,
    execIdA: a.execId,
    execIdB: b.execId,
    fields: shown,
    identical,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scalar(label: string, left: string | null | undefined, right: string | null | undefined): DiffField {
  const l = left ?? "";
  const r = right ?? "";
  let status: DiffStatus;
  if (l === r) status = "unchanged";
  else if (!l) status = "added";
  else if (!r) status = "removed";
  else status = "changed";
  return { label, status, left: l, right: r };
}

function diffHeaders(
  prefix: string,
  ha: Record<string, string> | null,
  hb: Record<string, string> | null
): DiffField[] {
  const a = ha ?? {};
  const b = hb ?? {};
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const fields: DiffField[] = [];

  for (const k of allKeys) {
    const av = a[k] ?? "";
    const bv = b[k] ?? "";
    if (av === bv && av === "") continue; // both absent — skip
    fields.push(scalar(`${prefix}: ${k}`, av, bv));
  }

  return fields;
}

function bodyDiff(
  a: unknown,
  b: unknown
): DiffField {
  const as = normalizeBody(bodyToString(a));
  const bs = normalizeBody(bodyToString(b));
  return scalar("Response Body", as, bs);
}

function bodyToString(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  try { return JSON.stringify(body, null, 2); } catch { return String(body); }
}

function normalizeBody(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  // Try to normalise JSON so whitespace differences don't show as changes
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function fmtStatus(c: HttpNodeCall): string {
  if (c.error && !c.statusCode) return `error: ${c.error.slice(0, 60)}`;
  if (!c.statusCode) return "";
  return `${c.statusCode}${c.statusMessage ? " " + c.statusMessage : ""}`;
}

function fmtMs(ms: number | null): string {
  return ms != null ? `${ms}ms` : "";
}

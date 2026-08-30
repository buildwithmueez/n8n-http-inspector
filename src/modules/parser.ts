/**
 * parser.ts
 *
 * Parses n8n execution API responses into a clean list of HTTP node calls.
 *
 * CONFIRMED SHAPE (from real traffic, 2026-08-30):
 *
 *  GET /rest/executions/{id}  →  { data: { <ExecutionObject> } }
 *
 *  ExecutionObject.data is a JSON STRING using n8n's indexed serialization:
 *  an array where string-number values are back-references to other indices.
 *
 *  Decoded shape:
 *    { version, startData, resultData: { runData, pinData, lastNodeExecuted }, executionData }
 *
 *  workflowData lives directly on ExecutionObject (not inside serialized data).
 *  workflowData.nodes[] → { name, type, parameters }
 *
 *  Error runs: runObj.error exists and runObj.executionStatus === "error"
 *  The error object may have { message, name, stack, cause, ... }
 *  For HTTP errors (4xx/5xx) n8n may store the response under error.cause or
 *  directly under runObj.data.main even on failure (depends on node settings).
 */

export interface HttpNodeCall {
  nodeName: string;
  runIndex: number;

  method: string | null;
  url: string | null;
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;

  statusCode: number | null;
  statusMessage: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown | null;

  startTime: number | null;
  executionTimeMs: number | null;
  executionStatus: string | null;

  rawOutputItems: unknown[];
  error: string | null;
  /** Full error details for display */
  errorDetail: Record<string, unknown> | null;
}

const HTTP_REQUEST_NODE_TYPE = "n8n-nodes-base.httpRequest";

// ---------------------------------------------------------------------------
// n8n indexed serialization decoder
// ---------------------------------------------------------------------------

function decodeN8nData(raw: string): unknown {
  let table: unknown[];
  try {
    table = JSON.parse(raw) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(table)) return table;

  function resolve(val: unknown, seen = new Set<string>()): unknown {
    if (typeof val === "string" && /^\d+$/.test(val)) {
      if (seen.has(val)) return null;
      const next = new Set(seen);
      next.add(val);
      const entry = table[parseInt(val, 10)];
      // flatted stores terminal strings directly in the table — they must NOT
      // be re-resolved as further references. Only objects/arrays can contain
      // more references. Without this guard, a string value like "30" stored
      // at table[2] would be followed as a reference to table[30] (undefined).
      if (entry === null || entry === undefined || typeof entry !== "object") {
        return entry;
      }
      return resolve(entry, next);
    }
    if (Array.isArray(val)) return val.map((v) => resolve(v, seen));
    if (val !== null && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = resolve(v, seen);
      }
      return out;
    }
    return val;
  }

  return resolve(table[0]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseExecution(executionJson: unknown): HttpNodeCall[] {
  const results: HttpNodeCall[] = [];
  if (!executionJson || typeof executionJson !== "object") return results;

  const exec = executionJson as Record<string, unknown>;
  // Unwrap { data: <exec> } REST envelope
  const root = (exec.data as Record<string, unknown>) ?? exec;

  // ---- 1. Node definitions ----
  const workflowData = root.workflowData as Record<string, unknown> | undefined;
  const nodes = (workflowData?.nodes as Array<Record<string, unknown>>) ?? [];

  const httpNodeNames = new Set<string>(
    nodes.filter((n) => n.type === HTTP_REQUEST_NODE_TYPE).map((n) => n.name as string)
  );

  const nodeParamsByName = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    if (node.name) {
      nodeParamsByName.set(node.name as string, (node.parameters as Record<string, unknown>) ?? {});
    }
  }

  if (httpNodeNames.size === 0) return results;

  // ---- 2. Decode serialized execution data ----
  const rawData = root.data;
  let decoded: Record<string, unknown> | null = null;

  if (typeof rawData === "string") {
    decoded = decodeN8nData(rawData) as Record<string, unknown> | null;
  } else if (rawData && typeof rawData === "object") {
    decoded = rawData as Record<string, unknown>;
  }

  if (!decoded) return results;

  // ---- 3. Navigate to runData ----
  const resultData = decoded.resultData as Record<string, unknown> | undefined;
  const runData = resultData?.runData as Record<string, unknown[]> | undefined;

  if (!runData) return results;

  // ---- 4. Extract runs ----
  for (const [nodeName, runs] of Object.entries(runData)) {
    if (!httpNodeNames.has(nodeName)) continue;
    if (!Array.isArray(runs)) continue;

    const params = nodeParamsByName.get(nodeName) ?? {};

    runs.forEach((run: unknown, runIndex: number) => {
      const runObj = run as Record<string, unknown>;

      const startTime = (runObj.startTime as number) ?? null;
      const executionTimeMs = (runObj.executionTime as number) ?? null;
      const executionStatus = (runObj.executionStatus as string) ?? null;

      // ---- Error handling ----
      // n8n sets runObj.error for node-level failures.
      // For HTTP 4xx/5xx with "Continue On Fail" off, the error object may
      // contain the response details inside error.cause or error.description.
      const errorObj = runObj.error as Record<string, unknown> | undefined;
      let errorMessage: string | null = null;
      let errorDetail: Record<string, unknown> | null = null;

      if (errorObj) {
        errorMessage = (errorObj.message as string) ?? (errorObj.description as string) ?? JSON.stringify(errorObj);
        errorDetail = errorObj;
      }

      // Output items (may exist even on error if "Continue On Fail" is on)
      const outputItems = extractOutputItems(runObj);
      const firstItem = outputItems.length > 0 ? (outputItems[0] as Record<string, unknown>) : null;

      const responseInfo = extractResponseInfo(firstItem, errorObj);
      const requestInfo = extractRequestInfo(firstItem, params, errorObj);

      results.push({
        nodeName,
        runIndex,
        method: requestInfo.method,
        url: requestInfo.url,
        requestHeaders: requestInfo.headers,
        requestBody: requestInfo.body,
        statusCode: responseInfo.statusCode,
        statusMessage: responseInfo.statusMessage,
        responseHeaders: responseInfo.headers,
        responseBody: responseInfo.body,
        startTime,
        executionTimeMs,
        executionStatus,
        rawOutputItems: outputItems,
        error: errorMessage,
        errorDetail,
      });
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOutputItems(runObj: Record<string, unknown>): unknown[] {
  try {
    const data = runObj.data as Record<string, unknown> | undefined;
    const main = data?.main as unknown[][] | undefined;
    if (Array.isArray(main) && Array.isArray(main[0])) return main[0];
  } catch { /* ignore */ }
  return [];
}

interface ResponseInfo {
  statusCode: number | null;
  statusMessage: string | null;
  headers: Record<string, string> | null;
  body: unknown | null;
}

function extractResponseInfo(
  item: Record<string, unknown> | null,
  errorObj?: Record<string, unknown>
): ResponseInfo {
  // Try to get response details from error object first (HTTP error responses)
  // n8n stores error response in error.cause for HTTP errors
  if (errorObj) {
    const cause = errorObj.cause as Record<string, unknown> | undefined;
    if (cause?.statusCode) {
      return {
        statusCode: (cause.statusCode as number) ?? null,
        statusMessage: (cause.statusMessage as string) ?? (cause.error as string) ?? null,
        headers: normalizeHeaders(cause.headers as Record<string, unknown> | undefined),
        body: cause.body ?? cause.description ?? null,
      };
    }
    // Some versions put it directly on the error
    if (typeof errorObj.statusCode === "number") {
      return {
        statusCode: errorObj.statusCode,
        statusMessage: (errorObj.statusMessage as string) ?? null,
        headers: null,
        body: errorObj.description ?? errorObj.body ?? null,
      };
    }
  }

  if (!item) return emptyResponse();
  const json = item.json as Record<string, unknown> | undefined;
  if (!json) return emptyResponse();

  // $response meta
  const $response = json["$response"] as Record<string, unknown> | undefined;
  if ($response) {
    return {
      statusCode: ($response.statusCode as number) ?? null,
      statusMessage: ($response.statusMessage as string) ?? null,
      headers: normalizeHeaders($response.headers as Record<string, unknown> | undefined),
      body: $response.body ?? null,
    };
  }

  // Flat statusCode
  if (typeof json.statusCode === "number") {
    return {
      statusCode: json.statusCode,
      statusMessage: (json.statusMessage as string) ?? null,
      headers: normalizeHeaders(json.headers as Record<string, unknown> | undefined),
      body: json.body ?? json.data ?? omitMetaFields(json),
    };
  }

  return { statusCode: null, statusMessage: null, headers: null, body: json };
}

interface RequestInfo {
  method: string | null;
  url: string | null;
  headers: Record<string, string> | null;
  body: string | null;
}

function extractRequestInfo(
  item: Record<string, unknown> | null,
  nodeParams: Record<string, unknown>,
  errorObj?: Record<string, unknown>
): RequestInfo {
  const json = item?.json as Record<string, unknown> | undefined;

  // $request meta on output item
  const $request = json?.["$request"] as Record<string, unknown> | undefined;
  if ($request) {
    return {
      method: ($request.method as string) ?? null,
      url: ($request.uri as string) ?? ($request.url as string) ?? null,
      headers: normalizeHeaders($request.headers as Record<string, unknown> | undefined),
      body: stringifyBody($request.body),
    };
  }

  // Some versions put request info in the error cause
  if (errorObj) {
    const cause = errorObj.cause as Record<string, unknown> | undefined;
    if (cause?.url || cause?.method) {
      return {
        method: (cause.method as string) ?? null,
        url: (cause.url as string) ?? null,
        headers: null,
        body: null,
      };
    }
  }

  // Fall back to static node parameters
  return {
    method: (nodeParams.method as string) ?? (nodeParams.requestMethod as string) ?? null,
    url: (nodeParams.url as string) ?? null,
    headers: extractHeadersFromNodeParams(nodeParams),
    body: extractBodyFromNodeParams(nodeParams),
  };
}

function emptyResponse(): ResponseInfo {
  return { statusCode: null, statusMessage: null, headers: null, body: null };
}

function normalizeHeaders(raw: Record<string, unknown> | undefined): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  return Object.keys(out).length > 0 ? out : null;
}

function omitMetaFields(json: Record<string, unknown>): Record<string, unknown> {
  const META = new Set(["$response", "$request", "$binary", "pairedItem"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) if (!META.has(k)) out[k] = v;
  return out;
}

function stringifyBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function extractHeadersFromNodeParams(params: Record<string, unknown>): Record<string, string> | null {
  try {
    const hp = params.headerParameters as { parameters: Array<{ name: string; value: string }> } | undefined;
    if (hp?.parameters?.length) {
      const out: Record<string, string> = {};
      for (const { name, value } of hp.parameters) if (name) out[name] = value ?? "";
      return Object.keys(out).length > 0 ? out : null;
    }
  } catch { /* ignore */ }
  return null;
}

function extractBodyFromNodeParams(params: Record<string, unknown>): string | null {
  // If n8n says no body is being sent, don't guess from stale leftover fields.
  if (params.sendBody === false) return null;

  // n8n's HTTP Request node uses `specifyBody` (or the older `contentType`) to
  // indicate which body mode is active. Read only from the matching field so
  // we don't accidentally pick up stale data left over from a previously-
  // selected mode.
  //
  // Confirmed field names from n8n community posts (2025-2026):
  //   specifyBody: "json"       → jsonBody contains the raw JSON string
  //   specifyBody: "keypairs"   → bodyParameters.parameters[] contains {name,value}
  //   specifyBody: "string"     → body contains a plain string
  //   contentType: "raw"        → body contains the raw value (older node versions)
  //   contentType: "json"       → body contains JSON string (older versions)

  const mode = (params.specifyBody as string | undefined)
    ?? (params.contentType as string | undefined)
    ?? (params.bodyContentType as string | undefined);

  if (mode === "json") {
    // Explicit JSON mode — jsonBody is authoritative
    if (typeof params.jsonBody === "string" && params.jsonBody.trim()) {
      return params.jsonBody;
    }
    // Fall through: some versions store it in body even in json mode
  }

  if (mode === "keypairs" || mode === "multipart-form-data" || mode === "form-urlencoded") {
    // Key-value pairs mode — convert [{name,value}] to flat object
    return extractKeypairBody(params.bodyParameters);
  }

  if (mode === "string" || mode === "raw") {
    // Raw string body — use body field directly
    if (typeof params.body === "string") return params.body;
  }

  // No mode field (older node versions) or mode not recognised:
  // fall back through the priority order, but now only touch each field
  // when it actually has content, to reduce the chance of stale-data hits.
  if (typeof params.body === "string" && params.body.trim()) return params.body;
  if (typeof params.jsonBody === "string" && params.jsonBody.trim()) return params.jsonBody;
  if (params.body && typeof params.body === "object") {
    return JSON.stringify(params.body, null, 2);
  }
  const kpResult = extractKeypairBody(params.bodyParameters);
  if (kpResult) return kpResult;

  return null;
}

function extractKeypairBody(bodyParameters: unknown): string | null {
  if (!bodyParameters || typeof bodyParameters !== "object") return null;
  const bp = bodyParameters as Record<string, unknown>;
  const pairs = bp.parameters as Array<{ name: string; value: unknown }> | undefined;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const obj: Record<string, unknown> = {};
  for (const { name, value } of pairs) {
    if (name) obj[name] = value ?? "";
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj, null, 2) : null;
}

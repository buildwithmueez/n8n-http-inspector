# DISCOVERY.md — n8n Execution API Investigation

**Status:** ⏳ Needs real traffic inspection before `parser.ts` can be finalized.

---

## What to do

1. Run a local n8n instance:
   ```bash
   npx n8n
   ```
   Default URL: `http://localhost:5678`

2. Create a workflow with 2–3 HTTP Request nodes:
   - `GET https://httpbin.org/get`
   - `POST https://jsonplaceholder.typicode.com/posts`
   - `GET https://httpbin.org/status/404` (deliberate failure)

3. Enable **"Include Response Headers and Status"** in at least one HTTP Request node,
   leave it OFF in another — document the difference.

4. Run the workflow, then open **DevTools → Network tab**.

5. Look for XHR/fetch calls to paths matching:
   - `/rest/executions/<id>`
   - `/api/v1/executions/<id>`

6. Copy the full JSON response body and paste it below in Section 3.

---

## 1. Confirmed API Endpoint

> Fill in after inspection.

| Property | Value |
|---|---|
| Method | GET |
| Path | `/rest/executions/{id}` ← confirm |
| Auth | Cookie-based (session) |
| Response Content-Type | `application/json` |

---

## 2. Confirmed Node Type String

> The `type` field on HTTP Request nodes in the workflow JSON.

Expected: `n8n-nodes-base.httpRequest`

**Confirmed:** ☐ Yes / ☐ No — actual value: `_______________`

---

## 3. Execution JSON Shape

Paste a real (sanitised) example here:

```json
{
  "TODO": "Paste real execution JSON here after running a test workflow"
}
```

### Key paths to identify:

| Data | JSON Path |
|---|---|
| Node definitions (name, type) | `data.workflowData.nodes[]` |
| Per-node run data | `data.resultData.runData["<NodeName>"][]` |
| Node execution time | `data.resultData.runData["X"][0].executionTime` |
| Node start time | `data.resultData.runData["X"][0].startTime` |
| Output items | `data.resultData.runData["X"][0].data.main[0][]` |
| Response body | `data.resultData.runData["X"][0].data.main[0][0].json` |
| Response status code | ??? — fill in after inspection |
| Response headers | ??? — fill in after inspection |
| Request URL (actual resolved) | ??? — fill in after inspection |
| Request headers | ??? — fill in after inspection |
| Request body | ??? — fill in after inspection |

---

## 4. Request Data Availability

| Field | Available by default? | Node setting required |
|---|---|---|
| Response status code | ☐ Yes / ☐ No | "Include Response Headers and Status" |
| Response headers | ☐ Yes / ☐ No | "Include Response Headers and Status" |
| Resolved request URL | ☐ Yes / ☐ No | Unknown |
| Request headers sent | ☐ Yes / ☐ No | Unknown |
| Request body sent | ☐ Yes / ☐ No | Unknown |

---

## 5. Findings & Parser Adjustments

> Fill in after inspection. Note any surprises vs. the assumptions in `parser.ts`
> and list any changes needed.

- [ ] Update `HTTP_REQUEST_NODE_TYPE` constant if different
- [ ] Update `extractResponseInfo()` paths if `$response` location is different
- [ ] Update `extractRequestInfo()` paths if `$request` exists / doesn't
- [ ] Document required node settings in README "Usage" section

/**
 * settings.ts — settings page script
 * Bundled by WXT and referenced from settings.html via <script type="module" src="./settings.ts">
 */

const STORAGE_KEY = "n8n_inspector_custom_domains";

function domainToOriginPattern(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return "";
  }
}

function setStatus(msg: string, type: "success" | "error" | "") {
  const el = document.getElementById("status-msg")!;
  el.textContent = msg;
  el.className = "status-msg " + type;
}

async function loadDomains(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      resolve((result[STORAGE_KEY] as string[]) || []);
    });
  });
}

async function saveDomains(domains: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: domains }, resolve);
  });
}

function renderDomains(domains: string[]) {
  const list = document.getElementById("domain-list")!;
  const emptyMsg = document.getElementById("empty-msg")!;

  list.innerHTML = "";
  emptyMsg.style.display = domains.length === 0 ? "block" : "none";

  domains.forEach((domain) => {
    const li = document.createElement("li");
    li.className = "domain-item";
    li.setAttribute("role", "listitem");

    const span = document.createElement("span");
    span.textContent = domain;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = "Remove";
    btn.setAttribute("aria-label", `Remove ${domain}`);
    btn.addEventListener("click", () => removeDomain(domain));

    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function addDomain() {
  const input = document.getElementById("domain-input") as HTMLInputElement;
  const raw = input.value.trim();
  if (!raw) return;

  const origin = domainToOriginPattern(raw);
  if (!origin) {
    setStatus("Enter a valid URL (e.g. https://n8n.example.com)", "error");
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (err: unknown) {
    setStatus(
      "Permission request failed: " + (err instanceof Error ? err.message : String(err)),
      "error"
    );
    return;
  }

  if (!granted) {
    setStatus("Permission denied — the domain was not added.", "error");
    return;
  }

  const domains = await loadDomains();
  if (!domains.includes(origin)) {
    domains.push(origin);
    await saveDomains(domains);
  }

  input.value = "";
  setStatus("Added: " + origin, "success");
  renderDomains(domains);
  setTimeout(() => setStatus("", ""), 3000);
}

async function removeDomain(domain: string) {
  const domains = await loadDomains();
  const updated = domains.filter((d) => d !== domain);
  await saveDomains(updated);
  try {
    await chrome.permissions.remove({ origins: [domain] });
  } catch {
    // ignore — browser may not allow removing all permissions this way
  }
  renderDomains(updated);
}

// Boot
loadDomains().then(renderDomains);
document.getElementById("add-btn")!.addEventListener("click", addDomain);
document.getElementById("domain-input")!.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDomain();
});

// Popup: reads the filter settings, collects visible post/reel links from the
// active Instagram tab, and hands them to the background worker.

const FIELDS = ["maxTabs", "include", "exclude", "minFollowers", "maxFollowers"];
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

// Remember the last-used settings (localStorage works in extension pages
// without needing the "storage" permission).
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("settings") || "{}");
    for (const id of FIELDS) {
      if (saved[id] !== undefined) document.getElementById(id).value = saved[id];
    }
  } catch (e) { /* ignore bad/missing saved settings */ }
}

function saveSettings() {
  try {
    const data = {};
    for (const id of FIELDS) data[id] = document.getElementById(id).value;
    localStorage.setItem("settings", JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

// "a, b ,, c" -> ["a", "b", "c"] (lowercased)
function parseList(text) {
  return text.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function parseNumber(text) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

// Runs INSIDE the Instagram page. Returns links to posts/reels that are
// currently visible in the viewport.
function collectVisibleLinks() {
  const anchors = document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]');
  const out = [];
  for (const a of anchors) {
    const r = a.getBoundingClientRect();
    const visible =
      r.width > 0 && r.height > 0 &&
      r.bottom > 0 && r.top < window.innerHeight &&
      r.right > 0 && r.left < window.innerWidth;
    if (visible) out.push(a.href);
  }
  return out;
}

document.getElementById("run").addEventListener("click", async () => {
  saveSettings();

  const maxTabs = parseNumber(document.getElementById("maxTabs").value) || 15;
  const filter = {
    include: parseList(document.getElementById("include").value),
    exclude: parseList(document.getElementById("exclude").value),
    minFollowers: parseNumber(document.getElementById("minFollowers").value),
    maxFollowers: parseNumber(document.getElementById("maxFollowers").value)
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith("https://www.instagram.com/")) {
    setStatus("Open an Instagram search/grid page first.");
    return;
  }

  let rawLinks = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectVisibleLinks
    });
    rawLinks = (res && res.result) || [];
  } catch (e) {
    setStatus("Couldn't read the page: " + e.message);
    return;
  }

  // Strip query strings / hashes, dedupe, cap at maxTabs.
  const seen = new Set();
  const urls = [];
  for (const href of rawLinks) {
    try {
      const u = new URL(href);
      const clean = u.origin + u.pathname;
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    } catch (e) { /* skip malformed */ }
    if (urls.length >= maxTabs) break;
  }

  if (urls.length === 0) {
    setStatus("No visible post/reel tiles found.");
    return;
  }

  setStatus(`Processing ${urls.length} link(s)…`);
  try {
    const reply = await chrome.runtime.sendMessage({ type: "run", urls, filter });
    if (reply && !reply.ok) setStatus(reply.error || "Background refused the run.");
    else setStatus(`Processing ${urls.length} link(s) in background. You can close this popup.`);
  } catch (e) {
    setStatus("Couldn't reach background: " + e.message);
  }
});

loadSettings();

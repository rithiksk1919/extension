// Background service worker: processes post/reel URLs one at a time.
// For each URL: open in a background tab -> find the poster's username ->
// load their profile -> check bio/followers against the filter ->
// keep the tab if it matches, close it otherwise.
//
// Strictly read-only: never clicks, follows, likes, or messages anything.

const RESERVED = new Set([
  "reels", "reel", "p", "explore", "direct", "accounts", "stories",
  "about", "legal", "developer", "web", "tv", "challenge", "emails"
]);

// Usernames already checked this session (resets if Chrome unloads the worker).
const seenUsers = new Set();
let running = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(1500 + Math.random() * 1500); // 1.5–3s

// Show remaining count on the toolbar icon.
function setBadge(n) {
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" }).catch(() => {});
}

// Resolve once the tab finishes loading, or after timeoutMs regardless.
// If checkCurrent is true, also resolve immediately if it's already complete.
function waitForComplete(tabId, timeoutMs = 15000, checkCurrent = false) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const onRemoved = id => { if (id === tabId) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    if (checkCurrent) {
      chrome.tabs.get(tabId)
        .then(t => { if (t.status === "complete") finish(); })
        .catch(finish); // tab gone
    }
  });
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
}

// Run a function inside the tab and return its result (null on any failure).
async function runInTab(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res ? res.result : null;
  } catch (e) {
    console.warn("executeScript failed:", e.message);
    return null;
  }
}

// "/username/reel/ID/" -> "username". Plain "/reel/ID/" -> null.
function usernameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && (parts[1] === "reel" || parts[1] === "p") && !RESERVED.has(parts[0])) {
      return parts[0];
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ---- Functions below run INSIDE the Instagram page ----

// Poll up to 10s for the post author's profile link in the main area.
async function findAuthorInPage(reserved) {
  const blocked = new Set(reserved);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const root = document.querySelector("main") || document.body;
    for (const a of root.querySelectorAll("a[href]")) {
      const m = (a.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]+)\/?$/);
      if (m && !blocked.has(m[1].toLowerCase())) return m[1];
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Wait for the profile header, then return { followers, bio }.
async function readProfileInPage() {
  const deadline = Date.now() + 10000;
  while (!document.querySelector("header") && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
  }
  const header = document.querySelector("header");
  const meta = document.querySelector('meta[property="og:description"]');
  const og = meta ? meta.getAttribute("content") || "" : "";

  // "12,345" / "12.3K" / "1.2M" -> number (null if unparseable)
  const toNumber = (digits, suffix) => {
    let n = parseFloat(String(digits).replace(/,/g, ""));
    const s = (suffix || "").toUpperCase();
    if (s === "K") n *= 1e3;
    else if (s === "M") n *= 1e6;
    else if (s === "B") n *= 1e9;
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const FOLLOWERS_RE = /([\d.,]+)\s*([KkMmBb]?)\s+followers/i;

  let followers = null;
  let source = null;

  let m;
  const link = header && header.querySelector('a[href$="/followers/"]');

  // 1. Exact count: <a href="/user/followers/"><span title="12,345">12.3K</span>
  const titled = link && link.querySelector("[title]");
  if (titled) {
    m = (titled.getAttribute("title") || "").match(/([\d.,]+)\s*([KkMmBb]?)/);
    if (m) { followers = toNumber(m[1], m[2]); source = "header-title"; }
  }

  // 2. og:description: "12.3K Followers, 456 Following, 78 Posts - ..."
  if (followers == null) {
    m = og.match(FOLLOWERS_RE);
    if (m) { followers = toNumber(m[1], m[2]); source = "og"; }
  }

  // 3. Visible text of the followers link, e.g. "12.3K followers".
  if (followers == null) {
    if (link) {
      m = link.innerText.match(/([\d.,]+)\s*([KkMmBb]?)/);
      if (m) { followers = toNumber(m[1], m[2]); source = "header-link"; }
    }
  }

  // 4. Any "N followers" text in the header.
  if (followers == null && header) {
    m = header.innerText.match(FOLLOWERS_RE);
    if (m) { followers = toNumber(m[1], m[2]); source = "header-text"; }
  }

  const bio = ((header ? header.innerText : "") + " " + og).toLowerCase();
  return { followers, source, bio };
}

// ---- Filter + main loop ----

// Returns null on match, or a short reason string on rejection.
function rejectReason(profile, filter) {
  const bio = profile.bio || "";
  if (filter.include.length && !filter.include.some(k => bio.includes(k))) return "bio missing include keyword";
  const bad = filter.exclude.find(k => bio.includes(k));
  if (bad) return `bio contains excluded "${bad}"`;

  // Follower check is strict: if a min or max is set and the count couldn't
  // be read, the profile is rejected rather than let through.
  const hasMin = filter.minFollowers != null;
  const hasMax = filter.maxFollowers != null;
  if (hasMin || hasMax) {
    if (profile.followers == null) return "follower count unreadable";
    if (hasMin && profile.followers < filter.minFollowers) return `followers ${profile.followers} < min ${filter.minFollowers}`;
    if (hasMax && profile.followers > filter.maxFollowers) return `followers ${profile.followers} > max ${filter.maxFollowers}`;
  }
  return null;
}

async function processUrl(url, filter) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.warn("Could not open tab:", url, e.message);
    return;
  }
  const tabId = tab.id;

  try {
    await waitForComplete(tabId, 15000, true);

    // 1. Username: from the URL if possible, otherwise from the page.
    let username = usernameFromUrl(url);
    if (!username) username = await runInTab(tabId, findAuthorInPage, [[...RESERVED]]);

    if (!username || seenUsers.has(username.toLowerCase())) {
      console.log("Skip (no username or already seen):", url, username);
      await closeTab(tabId);
      return;
    }
    seenUsers.add(username.toLowerCase());

    // 2. Load the profile in the same tab.
    const loaded = waitForComplete(tabId, 15000); // listen before navigating
    await chrome.tabs.update(tabId, { url: `https://www.instagram.com/${username}/` });
    await loaded;

    // 3. Read + filter.
    const profile = await runInTab(tabId, readProfileInPage);
    const reason = profile ? rejectReason(profile, filter) : "profile unreadable";
    if (!reason) {
      console.log("MATCH:", username, profile.followers, `(via ${profile.source})`);
      // Leave the tab open.
    } else {
      console.log("No match:", username, "-", reason);
      await closeTab(tabId);
    }
  } catch (e) {
    console.warn("Error processing", url, e.message);
    await closeTab(tabId);
  }
}

async function run(urls, filter) {
  running = true;
  try {
    for (let i = 0; i < urls.length; i++) {
      setBadge(urls.length - i);
      await processUrl(urls[i], filter);
      if (i < urls.length - 1) await randomDelay();
    }
  } finally {
    running = false;
    setBadge(0);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "run") return;
  if (running) {
    sendResponse({ ok: false, error: "A run is already in progress." });
    return;
  }
  sendResponse({ ok: true });
  run(msg.urls || [], msg.filter || { include: [], exclude: [] }); // don't await: keep going after popup closes
});

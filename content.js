const BLOCKED_CLASS = "pohoda-blocked";
const BLOCK_BTN_CLASS = "pohoda-block-btn";
const PIN_BTN_CLASS = "pohoda-pin-btn";
const PINNED_CLASS = "pohoda-pinned";
const NEWEST_CLASS = "pohoda-newest";
const NEWEST_FLASH_CLASS = "pohoda-newest-flash";
const MUTED_CLASS = "pohoda-muted";
const WATCH_CLASS = "pohoda-watch";

let blockedSet = new Set();
let watchKeywords = [];
let muteKeywords = [];
let lastPopupPostId = null;
let domObserver = null;
let pinnedThreadIds = [];
let applyingPin = false;
let domScanTimer = null;
let lastDomScanPostId = null;

const POPUP_MAX_AGE_MS = 300000;

function extensionAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function stopObserving() {
  domObserver?.disconnect();
  domObserver = null;
}

async function storageGet(keys) {
  if (!extensionAlive()) {
    stopObserving();
    return {};
  }
  return chrome.storage.local.get(keys);
}

async function storageSet(data) {
  if (!extensionAlive()) {
    stopObserving();
    return;
  }
  await chrome.storage.local.set(data);
}

async function storageRemove(keys) {
  if (!extensionAlive()) {
    stopObserving();
    return;
  }
  await chrome.storage.local.remove(keys);
}

function safeRun(fn) {
  if (!extensionAlive()) {
    stopObserving();
    return;
  }
  Promise.resolve(fn()).catch(() => stopObserving());
}

// Must exist before init — background delivers popup / fetch fallback.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!extensionAlive()) return;

  if (msg.type === "SHOW_PAGE_POPUP" && msg.post?.id) {
    checkPagePopup(msg.post)
      .then(() => sendResponse({ ok: true }))
      .catch(() => {
        stopObserving();
        sendResponse({ ok: false });
      });
    return true;
  }

  if (msg.type === "FETCH_WEBPARTY_HTML") {
    fetch(`https://www.pohodafestival.sk/webparty?_=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" }
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((html) => sendResponse({ html }))
      .catch((err) => sendResponse({ error: String(err.message || err) }));
    return true;
  }
});

init();

async function init() {
  if (!extensionAlive()) return;

  await initI18n();

  if (isReplyPage()) {
    initReplyPreview();
    return;
  }

  await loadSettings();
  applyBlocking();
  applyKeywordFilters();
  injectBlockButtons();
  injectPinButtons();
  observeDOM();
  await highlightNewestPost();
  await applyPinnedThreads();
  await checkPagePopup();
  scheduleDomPostScan(true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !extensionAlive()) {
      stopObserving();
      return;
    }

    if (changes.language) {
      safeRun(async () => {
        await initI18n();
        updateBlockButtons();
        updatePinButtons();
        await highlightNewestPost();
      });
    }

    if (changes.pinnedThreadIds) {
      loadPinnedFromStorage(changes.pinnedThreadIds.newValue);
      safeRun(() => applyPinnedThreads());
    } else if (changes.pinnedThreadId) {
      loadPinnedFromStorage(changes.pinnedThreadId.newValue);
      safeRun(() => applyPinnedThreads());
    }

    if (changes.blockedUsers) {
      blockedSet = buildSet(changes.blockedUsers.newValue || []);
      applyBlocking();
      updateBlockButtons();
    }

    if (changes.watchKeywords) {
      watchKeywords = normalizeKeywords(changes.watchKeywords.newValue || []);
      applyKeywordFilters();
    }

    if (changes.muteKeywords) {
      muteKeywords = normalizeKeywords(changes.muteKeywords.newValue || []);
      applyKeywordFilters();
    }

    if (changes.highlightPostId || changes.lastPostId) {
      safeRun(highlightNewestPost);
    }

    if ("pagePopupPost" in changes) {
      safeRun(() => checkPagePopup(changes.pagePopupPost.newValue));
    }
  });
}

function normalizeKeywords(list) {
  return (list || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
}

function buildSet(list) {
  return new Set((list || []).map((u) => u.toLowerCase()));
}

async function loadSettings() {
  const data = await storageGet(["blockedUsers", "watchKeywords", "muteKeywords", "pinnedThreadIds", "pinnedThreadId"]);
  blockedSet = buildSet(data.blockedUsers || []);
  watchKeywords = normalizeKeywords(data.watchKeywords || []);
  muteKeywords = normalizeKeywords(data.muteKeywords || []);
  loadPinnedFromStorage(data.pinnedThreadIds ?? data.pinnedThreadId);

  if (!data.pinnedThreadIds && data.pinnedThreadId) {
    await storageSet({ pinnedThreadIds, pinnedThreadId: null });
  }
}

function normalizePinnedIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((id) => typeof id === "string" && id.startsWith("comment")))];
  }
  if (typeof value === "string" && value.startsWith("comment")) return [value];
  return [];
}

function loadPinnedFromStorage(raw) {
  pinnedThreadIds = normalizePinnedIds(raw);
}

function isPinned(id) {
  return pinnedThreadIds.includes(id);
}

function getPostText(li) {
  const thread = getDirectThread(li);
  return (thread?.querySelector(".thread-content")?.textContent || "").toLowerCase();
}

function matchesAny(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

function applyKeywordFilters() {
  getPostElements().forEach((li) => {
    const thread = getDirectThread(li);
    if (!thread) return;

    const text = getPostText(li);
    const muted = muteKeywords.length > 0 && matchesAny(text, muteKeywords);
    const watched = watchKeywords.length > 0 && matchesAny(text, watchKeywords);

    thread.classList.toggle(MUTED_CLASS, muted);
    thread.classList.toggle(WATCH_CLASS, watched && !muted);
  });
}

/** Only the direct post in this li — not nested replies inside ul.thread-replies */
function getDirectThread(li) {
  return li.querySelector(":scope > .thread");
}

function getUsername(li) {
  const thread = getDirectThread(li);
  const link = thread?.querySelector(".thread-header strong a");
  return link?.textContent?.trim() || "";
}

function isBlocked(username) {
  return blockedSet.has(username.toLowerCase());
}

function getThreadsList() {
  return document.querySelector("ul.threads");
}

/** Root top-level li in ul.threads (whole conversation including replies). */
function getRootThreadLi(li) {
  let current = li;
  while (current?.matches?.('li[id^="comment"]')) {
    const parent = current.parentElement;
    if (parent?.classList.contains("threads")) return current;
    if (parent?.classList.contains("thread-replies")) {
      current = parent.parentElement;
      continue;
    }
    break;
  }
  return li;
}

function getTopLevelThreads() {
  const threads = getThreadsList();
  return threads ? [...threads.querySelectorAll(':scope > li[id^="comment"]')] : [];
}

function getPostElements() {
  return document.querySelectorAll('li[id^="comment"]');
}

function injectPinButtons() {
  getPostElements().forEach((li) => {
    if (getRootThreadLi(li) !== li) {
      getDirectThread(li)?.querySelector(`.${PIN_BTN_CLASS}`)?.remove();
    }
  });
  getTopLevelThreads().forEach(addPinButton);
}

function addPinButton(li) {
  const thread = getDirectThread(li);
  if (!thread || thread.querySelector(`.${PIN_BTN_CLASS}`)) return;

  const btn = document.createElement("button");
  btn.className = PIN_BTN_CLASS;
  btn.type = "button";
  btn.title = t("pinTitle");
  btn.textContent = "📌";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePinThread(li);
  });

  thread.appendChild(btn);
  updatePinButtonState(btn, li);
}

function updatePinButtonState(btn, li) {
  const root = getRootThreadLi(li);
  const active = isPinned(root.id);
  btn.textContent = active ? "📍" : "📌";
  btn.title = active ? t("unpinTitle") : t("pinTitle");
  btn.classList.toggle("is-pinned", active);
}

function updatePinButtons() {
  getTopLevelThreads().forEach((li) => {
    const btn = getDirectThread(li)?.querySelector(`.${PIN_BTN_CLASS}`);
    if (btn) updatePinButtonState(btn, li);
  });
}

function isPinnedLayoutStable() {
  if (!pinnedThreadIds.length) return true;

  const threads = getThreadsList();
  if (!threads) return false;

  let child = threads.firstElementChild;
  for (const id of pinnedThreadIds) {
    if (!child?.matches?.('li[id^="comment"]')) return false;
    if (child.id !== id || !child.classList.contains(PINNED_CLASS)) return false;
    if (!child.querySelector(".pohoda-pinned-badge")) return false;
    child = child.nextElementSibling;
  }

  return true;
}

async function togglePinThread(li) {
  if (!extensionAlive()) return;

  const root = getRootThreadLi(li);
  const idx = pinnedThreadIds.indexOf(root.id);

  if (idx >= 0) {
    pinnedThreadIds.splice(idx, 1);
  } else {
    pinnedThreadIds.unshift(root.id);
  }

  await storageSet({ pinnedThreadIds: [...pinnedThreadIds] });
  await applyPinnedThreads(true);
}

function insertAtNaturalPosition(rootLi) {
  const threads = getThreadsList();
  if (!threads || !rootLi) return;

  const num = parseInt(rootLi.id.replace("comment", ""), 10) || 0;
  const siblings = getTopLevelThreads().filter(
    (item) =>
      item !== rootLi &&
      !isPinned(item.id) &&
      !item.classList.contains("pohoda-pinned-fetched")
  );

  for (const sib of siblings) {
    const sNum = parseInt(sib.id.replace("comment", ""), 10) || 0;
    if (num > sNum) {
      threads.insertBefore(rootLi, sib);
      return;
    }
  }

  threads.appendChild(rootLi);
}

function clearPinnedVisuals() {
  document.querySelectorAll(`.${PINNED_CLASS}`).forEach((el) => {
    el.classList.remove(PINNED_CLASS, "pohoda-pinned-fetched");
  });
  document.querySelectorAll(".pohoda-pinned-badge").forEach((b) => b.remove());
  document.querySelectorAll('[data-pohoda-hidden-dup="1"]').forEach((el) => {
    el.style.display = "";
    el.removeAttribute("data-pohoda-hidden-dup");
  });
}

function expandAllReplies(rootLi) {
  rootLi.querySelectorAll("ul.thread-replies").forEach((ul) => {
    ul.style.display = "block";
    ul.hidden = false;
  });
}

function dedupePinnedThread(rootId) {
  const all = document.querySelectorAll(`li#${CSS.escape(rootId)}`);
  if (all.length <= 1) return;

  const pinned = document.querySelector(`li.${PINNED_CLASS}#${CSS.escape(rootId)}`);
  all.forEach((el) => {
    if (el !== pinned) {
      el.style.display = "none";
      el.setAttribute("data-pohoda-hidden-dup", "1");
    }
  });
}

function addPinnedBadge(rootLi) {
  const thread = getDirectThread(rootLi);
  if (!thread || thread.querySelector(".pohoda-pinned-badge")) return;

  const badge = document.createElement("span");
  badge.className = "pohoda-pinned-badge";
  badge.textContent = t("badgePinned");
  thread.appendChild(badge);
}

function decoratePinnedThread(rootLi, fetched = false) {
  rootLi.classList.add(PINNED_CLASS);
  rootLi.classList.toggle("pohoda-pinned-fetched", fetched);
  expandAllReplies(rootLi);
  addPinnedBadge(rootLi);
  dedupePinnedThread(rootLi.id);
}

async function resolvePinnedRootNode(id) {
  let rootLi = document.getElementById(id);
  if (rootLi) rootLi = getRootThreadLi(rootLi);

  if (rootLi?.isConnected && getRootThreadLi(rootLi) === rootLi &&
      rootLi.parentElement?.classList.contains("threads")) {
    return { node: rootLi, fetched: false };
  }

  const existingFetched = document.querySelector(`li.pohoda-pinned-fetched#${CSS.escape(id)}`);
  if (existingFetched) return { node: existingFetched, fetched: true };

  const fetched = await fetchRootThreadNode(id);
  return fetched ? { node: fetched, fetched: true } : null;
}

async function applyPinnedThreads(force = false) {
  if (!extensionAlive() || applyingPin) return;

  applyingPin = true;
  try {
    const data = await storageGet(["pinnedThreadIds", "pinnedThreadId"]);
    loadPinnedFromStorage(data.pinnedThreadIds ?? data.pinnedThreadId);

    if (!pinnedThreadIds.length) {
      clearPinnedVisuals();
      restoreUnpinnedPositions();
      updatePinButtons();
      return;
    }

    if (!force && isPinnedLayoutStable()) {
      updatePinButtons();
      return;
    }

    const threads = getThreadsList();
    if (!threads) return;

    clearPinnedVisuals();

    document.querySelectorAll("li.pohoda-pinned-fetched").forEach((el) => {
      if (!pinnedThreadIds.includes(el.id)) el.remove();
    });

    const resolved = [];
    for (const id of pinnedThreadIds) {
      const result = await resolvePinnedRootNode(id);
      if (result) resolved.push({ id, ...result });
    }

    pinnedThreadIds = resolved.map((item) => item.id);
    if (pinnedThreadIds.length !== normalizePinnedIds(data.pinnedThreadIds ?? data.pinnedThreadId).length) {
      await storageSet({ pinnedThreadIds: [...pinnedThreadIds] });
    }

    let insertBefore = threads.firstElementChild;
    for (const { node, fetched } of resolved) {
      decoratePinnedThread(node, fetched);
      threads.insertBefore(node, insertBefore);
      insertBefore = node.nextElementSibling;
    }

    restoreUnpinnedPositions();
    updatePinButtons();
  } finally {
    applyingPin = false;
  }
}

function restoreUnpinnedPositions() {
  const pinnedSet = new Set(pinnedThreadIds);
  getTopLevelThreads().forEach((li) => {
    if (!pinnedSet.has(li.id) && !li.classList.contains("pohoda-pinned-fetched")) {
      insertAtNaturalPosition(li);
    }
  });
}

async function fetchRootThreadNode(rootId) {
  for (let page = 1; page <= 10; page++) {
    const url = page === 1
      ? "https://www.pohodafestival.sk/webparty"
      : `https://www.pohodafestival.sk/webparty?page=${page}`;

    try {
      const res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res.ok) break;

      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const li = doc.getElementById(rootId) || findRootLiContaining(doc, rootId);
      if (!li) continue;

      return document.importNode(getRootThreadLi(li), true);
    } catch {
      break;
    }
  }

  return null;
}

function findRootLiContaining(doc, commentId) {
  const el = doc.getElementById(commentId);
  return el ? getRootThreadLi(el) : null;
}

function applyBlocking() {
  getPostElements().forEach((li) => {
    const thread = getDirectThread(li);
    if (!thread) return;

    const blocked = isBlocked(getUsername(li));
    thread.classList.toggle(BLOCKED_CLASS, blocked);
  });
}

function injectBlockButtons() {
  getPostElements().forEach(addBlockButton);
}

function addBlockButton(li) {
  const thread = getDirectThread(li);
  if (!thread || thread.querySelector(`.${BLOCK_BTN_CLASS}`)) return;

  const btn = document.createElement("button");
  btn.className = BLOCK_BTN_CLASS;
  btn.type = "button";
  btn.title = t("blockTitle");
  btn.textContent = "⊘";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleBlockUser(getUsername(li));
  });

  thread.appendChild(btn);
  updateButtonState(btn, getUsername(li));
}

function updateButtonState(btn, username) {
  const blocked = isBlocked(username);
  btn.textContent = blocked ? "✓" : "⊘";
  btn.title = blocked ? t("unblockUser", { user: username }) : t("blockUser", { user: username });
  btn.classList.toggle("is-blocked", blocked);
}

function updateBlockButtons() {
  getPostElements().forEach((li) => {
    const thread = getDirectThread(li);
    const btn = thread?.querySelector(`.${BLOCK_BTN_CLASS}`);
    if (btn) updateButtonState(btn, getUsername(li));
  });
}

async function toggleBlockUser(username) {
  if (!username || !extensionAlive()) return;

  const key = username.toLowerCase();
  const { blockedUsers = [] } = await storageGet("blockedUsers");
  const list = blockedUsers.slice();
  const idx = list.findIndex((u) => u.toLowerCase() === key);

  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(username);
  }

  await storageSet({ blockedUsers: list });
  blockedSet = buildSet(list);
  applyBlocking();
  updateBlockButtons();
}

function observeDOM() {
  const target = document.querySelector("ul.threads") || document.body;
  let timer;

  domObserver = new MutationObserver(() => {
    if (!extensionAlive()) {
      stopObserving();
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!extensionAlive()) {
        stopObserving();
        return;
      }
      applyBlocking();
      applyKeywordFilters();
      injectBlockButtons();
      injectPinButtons();
      safeRun(highlightNewestPost);
      if (pinnedThreadIds.length && !isPinnedLayoutStable()) {
        safeRun(() => applyPinnedThreads());
      }
      scheduleDomPostScan();
    }, 120);
  });

  domObserver.observe(target, { childList: true, subtree: true });
}

function parseTimestamp(dateStr) {
  const match = (dateStr || "").match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const [, day, month, year, hour, minute] = match;
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function getNewestVisiblePost() {
  let newest = null;
  let newestNum = 0;

  document.querySelectorAll('li[id^="comment"]').forEach((li) => {
    const commentNum = parseInt(li.id.replace("comment", ""), 10) || 0;
    if (commentNum <= newestNum) return;

    const parsed = parseCommentFromLi(li);
    if (!parsed?.content) return;

    newestNum = commentNum;
    newest = {
      ...parsed,
      commentNum,
      timestamp: parseTimestamp(parsed.date)
    };
  });

  return newest;
}

function scheduleDomPostScan(force = false) {
  if (!extensionAlive()) return;

  clearTimeout(domScanTimer);
  domScanTimer = setTimeout(() => {
    safeRun(() => scanForNewPostsInDom(force));
  }, force ? 0 : 400);
}

async function scanForNewPostsInDom(force = false) {
  if (!extensionAlive()) {
    stopObserving();
    return;
  }

  const newest = getNewestVisiblePost();
  if (!newest?.id) return;

  if (!force && newest.id === lastDomScanPostId) return;
  lastDomScanPostId = newest.id;

  const { lastPostId } = await storageGet("lastPostId");
  if (lastPostId === newest.id) return;

  const lastNum = lastPostId ? parseInt(lastPostId.replace("comment", ""), 10) || 0 : 0;
  if (newest.commentNum <= lastNum) return;

  chrome.runtime.sendMessage({ type: "REPORT_NEW_POST", post: newest }, () => {
    if (chrome.runtime.lastError) stopObserving();
  });
}

async function highlightNewestPost() {
  if (!extensionAlive()) {
    stopObserving();
    return;
  }

  const { highlightPostId, lastPostId } = await storageGet([
    "highlightPostId",
    "lastPostId"
  ]);

  const postId = highlightPostId || lastPostId;
  if (!postId) return;

  document.querySelectorAll(`.${NEWEST_CLASS}`).forEach((el) => {
    el.classList.remove(NEWEST_CLASS, NEWEST_FLASH_CLASS);
  });
  document.querySelectorAll(".pohoda-new-badge").forEach((b) => b.remove());

  const li = document.getElementById(postId);
  if (!li) return;

  li.classList.add(NEWEST_CLASS);
  addNewBadge(li);

  if (highlightPostId) {
    li.classList.add(NEWEST_FLASH_CLASS);
    await storageRemove("highlightPostId");
  }
}

async function checkPagePopup(post) {
  if (!extensionAlive()) return;

  if (post === undefined) {
    const data = await storageGet("pagePopupPost");
    post = data.pagePopupPost;
  }

  if (!post?.id) return;
  if (post.id === lastPopupPostId) return;

  const age = Date.now() - (post.at || 0);
  if (post.at && age > POPUP_MAX_AGE_MS) {
    await storageRemove("pagePopupPost");
    return;
  }

  lastPopupPostId = post.id;
  await initI18n();
  showPagePopup(post);
}

function showPagePopup(post) {
  document.querySelector(".pohoda-page-popup")?.remove();

  const preview = (post.content || "").trim();
  const shortPreview = preview.length > 160 ? preview.slice(0, 160) + "…" : preview;

  const popup = document.createElement("div");
  popup.className = "pohoda-page-popup";
  popup.innerHTML = `
    <div class="pohoda-page-popup-inner">
      <div class="pohoda-page-popup-header">
        <span class="pohoda-page-popup-label">${post.watched ? "🔔 " : ""}${escapeHtml(t("popupNewPost"))}</span>
        <button type="button" class="pohoda-page-popup-x" aria-label="${escapeAttr(t("popupDismiss"))}">×</button>
      </div>
      <div class="pohoda-page-popup-meta">
        <strong>${escapeHtml(post.user || "")}</strong>
        <span>${escapeHtml(post.date || "")}</span>
      </div>
      <p class="pohoda-page-popup-text">${escapeHtml(shortPreview)}</p>
      <div class="pohoda-page-popup-actions">
        <button type="button" class="pohoda-popup-btn dismiss">${escapeHtml(t("popupDismiss"))}</button>
        <button type="button" class="pohoda-popup-btn primary go">${escapeHtml(t("popupGoToPost"))}</button>
      </div>
    </div>`;

  const root = document.documentElement;
  root.appendChild(popup);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => popup.classList.add("visible"));
  });

  const close = () => dismissPagePopup(popup);
  popup.querySelector(".pohoda-page-popup-x").addEventListener("click", close);
  popup.querySelector(".pohoda-popup-btn.dismiss").addEventListener("click", close);
  popup.querySelector(".pohoda-popup-btn.go").addEventListener("click", () => {
    goToPost(post.id);
    close();
  });
}

async function dismissPagePopup(popup) {
  popup?.classList.remove("visible");
  setTimeout(() => popup?.remove(), 220);
  await storageRemove("pagePopupPost");
}

function goToPost(postId) {
  if (!postId) return;

  const li = document.getElementById(postId);
  if (li) {
    li.classList.add(NEWEST_FLASH_CLASS);
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    safeRun(highlightNewestPost);
    if (history.replaceState) {
      history.replaceState(null, "", `#${postId}`);
    } else {
      location.hash = postId;
    }
    return;
  }

  window.location.href = `${location.pathname}${location.search}#${postId}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

function addNewBadge(li) {
  const thread = getDirectThread(li);
  if (!thread || thread.querySelector(".pohoda-new-badge")) return;

  const badge = document.createElement("span");
  badge.className = "pohoda-new-badge";
  badge.textContent = t("badgeLatest");
  thread.appendChild(badge);
}

// ---- Reply page: show parent post being answered ----

function isReplyPage() {
  return /\/webparty\/reply\/(\d+)/i.test(location.pathname);
}

function getReplyCommentNum() {
  const m = location.pathname.match(/\/webparty\/reply\/(\d+)/i);
  return m ? m[1] : null;
}

function initReplyPreview() {
  const commentNum = getReplyCommentNum();
  if (!commentNum) return;

  let done = false;

  const mount = async () => {
    if (done || document.querySelector(".pohoda-reply-preview")) return true;

    const textarea = document.querySelector("textarea.webparty-input, main textarea, .wrapper textarea");
    if (!textarea) return false;

    done = true;
    showReplyPreviewLoading(textarea);
    const post = await fetchCommentById(commentNum);
    renderReplyPreview(textarea, post);
    return true;
  };

  mount();

  const observer = new MutationObserver(() => {
    mount().then((ready) => {
      if (ready) observer.disconnect();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
}

function showReplyPreviewLoading(textarea) {
  const preview = buildReplyPreviewEl(null, true);
  insertReplyPreview(textarea, preview);
}

function renderReplyPreview(textarea, post) {
  document.querySelector(".pohoda-reply-preview")?.remove();
  insertReplyPreview(textarea, buildReplyPreviewEl(post, false));
}

function insertReplyPreview(textarea, preview) {
  const form = textarea.closest("form");
  const block = form || textarea.closest(".wrapper") || textarea.parentElement;
  if (!block) return;

  if (form && form.parentElement) {
    form.parentElement.insertBefore(preview, form);
  } else {
    block.insertBefore(preview, block.firstChild);
  }
}

function buildReplyPreviewEl(post, loading) {
  const el = document.createElement("div");
  el.className = "pohoda-reply-preview";

  if (loading) {
    el.innerHTML = `
      <div class="pohoda-reply-preview-label">${escapeHtml(t("replyingTo"))}</div>
      <p class="pohoda-reply-preview-loading">${escapeHtml(t("replyLoading"))}</p>`;
    return el;
  }

  if (!post) {
    el.innerHTML = `
      <div class="pohoda-reply-preview-label">${escapeHtml(t("replyingTo"))}</div>
      <p class="pohoda-reply-preview-missing">${escapeHtml(t("replyNotFound"))}</p>`;
    return el;
  }

  el.innerHTML = `
    <div class="pohoda-reply-preview-label">${escapeHtml(t("replyingTo"))}</div>
    <div class="pohoda-reply-preview-meta">
      <strong>${escapeHtml(post.user || "")}</strong>
      <span>${escapeHtml(post.date || "")}</span>
    </div>
    <div class="pohoda-reply-preview-text">${escapeHtml(post.content || "")}</div>`;

  return el;
}

async function fetchCommentById(commentNum) {
  const fullId = `comment${commentNum}`;

  const { postHistory = [], lastPost } = await storageGet(["postHistory", "lastPost"]);
  const cached = postHistory.find((p) => p.id === fullId) || (lastPost?.id === fullId ? lastPost : null);
  if (cached?.content) return cached;

  try {
    const res = await fetch("https://www.pohodafestival.sk/webparty", {
      credentials: "include",
      cache: "no-store"
    });
    if (!res.ok) return null;

    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const li = doc.getElementById(fullId);
    if (li) return parseCommentFromLi(li);

    return searchCommentInPages(commentNum, 2, 6);
  } catch {
    return null;
  }
}

async function searchCommentInPages(commentNum, fromPage, toPage) {
  const fullId = `comment${commentNum}`;

  for (let page = fromPage; page <= toPage; page++) {
    try {
      const res = await fetch(`https://www.pohodafestival.sk/webparty?page=${page}`, {
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) break;

      const li = new DOMParser()
        .parseFromString(await res.text(), "text/html")
        .getElementById(fullId);

      if (li) return parseCommentFromLi(li);
    } catch {
      break;
    }
  }

  return null;
}

function parseCommentFromLi(li) {
  const thread = li.querySelector(":scope > .thread");
  if (!thread) return null;

  const user = thread.querySelector(".thread-header strong a")?.textContent?.trim() || "";
  const headerText = thread.querySelector(".thread-header")?.textContent || "";
  const dateMatch = headerText.match(/(\d{1,2}\.\s*\d{1,2}\.\s*\d{4},?\s*\d{1,2}:\d{2})/);
  let content = thread.querySelector(".thread-content")?.textContent?.trim() || "";
  content = content.replace(/\s*Odpovedať\s*/gi, "").trim();

  return {
    id: li.id,
    user,
    date: dateMatch ? dateMatch[1].trim() : "",
    content
  };
}

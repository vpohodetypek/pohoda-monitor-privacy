const BLOCKED_CLASS = "pohoda-blocked";
const BLOCK_BTN_CLASS = "pohoda-block-btn";
const NEWEST_CLASS = "pohoda-newest";
const NEWEST_FLASH_CLASS = "pohoda-newest-flash";
const MUTED_CLASS = "pohoda-muted";
const WATCH_CLASS = "pohoda-watch";

let blockedSet = new Set();
let watchKeywords = [];
let muteKeywords = [];
let lastPopupPostId = null;

const POPUP_MAX_AGE_MS = 120000;

init();

async function init() {
  await initI18n();
  await loadSettings();
  applyBlocking();
  applyKeywordFilters();
  injectBlockButtons();
  observeDOM();
  await highlightNewestPost();
  await checkPagePopup();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.language) {
      initI18n().then(() => {
        updateBlockButtons();
        highlightNewestPost();
      });
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
      highlightNewestPost();
    }

    if (changes.pagePopupPost) {
      checkPagePopup(changes.pagePopupPost.newValue);
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
  const { blockedUsers = [], watchKeywords: wk = [], muteKeywords: mk = [] } =
    await chrome.storage.local.get(["blockedUsers", "watchKeywords", "muteKeywords"]);
  blockedSet = buildSet(blockedUsers);
  watchKeywords = normalizeKeywords(wk);
  muteKeywords = normalizeKeywords(mk);
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

function getPostElements() {
  return document.querySelectorAll('li[id^="comment"]');
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
  if (!username) return;

  const key = username.toLowerCase();
  const { blockedUsers = [] } = await chrome.storage.local.get("blockedUsers");
  const list = blockedUsers.slice();
  const idx = list.findIndex((u) => u.toLowerCase() === key);

  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(username);
  }

  await chrome.storage.local.set({ blockedUsers: list });
  blockedSet = buildSet(list);
  applyBlocking();
  updateBlockButtons();
}

function observeDOM() {
  const target = document.querySelector("ul.threads") || document.body;
  let timer;

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      applyBlocking();
      applyKeywordFilters();
      injectBlockButtons();
      highlightNewestPost();
    }, 120);
  });

  observer.observe(target, { childList: true, subtree: true });
}

async function highlightNewestPost() {
  const { highlightPostId, lastPostId } = await chrome.storage.local.get([
    "highlightPostId",
    "lastPostId"
  ]);

  const postId = highlightPostId || lastPostId;
  if (!postId) return;

  // Clear previous highlight + badges
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
    await chrome.storage.local.remove("highlightPostId");
  }
}

async function checkPagePopup(post) {
  if (post === undefined) {
    const data = await chrome.storage.local.get("pagePopupPost");
    post = data.pagePopupPost;
  }

  if (!post?.id) return;
  if (post.id === lastPopupPostId) return;
  if (Date.now() - (post.at || 0) > POPUP_MAX_AGE_MS) {
    await chrome.storage.local.remove("pagePopupPost");
    return;
  }

  lastPopupPostId = post.id;
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

  document.body.appendChild(popup);
  requestAnimationFrame(() => popup.classList.add("visible"));

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
  await chrome.storage.local.remove("pagePopupPost");
}

function goToPost(postId) {
  if (!postId) return;

  const li = document.getElementById(postId);
  if (li) {
    li.classList.add(NEWEST_FLASH_CLASS);
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    highlightNewestPost();
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

const TARGET_URL = "https://www.pohodafestival.sk/webparty";

const $ = (id) => document.getElementById(id);

const PRESET_INTERVALS = ["1", "2", "3", "5", "10", "15", "30", "60"];

const els = {
  monitoringEnabled: $("monitoringEnabled"),
  intervalSelect: $("intervalSelect"),
  customIntervalRow: $("customIntervalRow"),
  customInterval: $("customInterval"),
  notificationsEnabled: $("notificationsEnabled"),
  soundEnabled: $("soundEnabled"),
  requireInteraction: $("requireInteraction"),
  notifyBlocked: $("notifyBlocked"),
  previewLength: $("previewLength"),
  previewLengthValue: $("previewLengthValue"),
  badgeColor: $("badgeColor"),
  quietHoursEnabled: $("quietHoursEnabled"),
  quietHoursRow: $("quietHoursRow"),
  quietStart: $("quietStart"),
  quietEnd: $("quietEnd"),
  watchInput: $("watchInput"),
  addWatchBtn: $("addWatchBtn"),
  watchChips: $("watchChips"),
  muteInput: $("muteInput"),
  addMuteBtn: $("addMuteBtn"),
  muteChips: $("muteChips"),
  manualUsername: $("manualUsername"),
  addBtn: $("addBtn"),
  userSearch: $("userSearch"),
  discoverBtn: $("discoverBtn"),
  discoverSpinner: $("discoverSpinner"),
  discoverResults: $("discoverResults"),
  discoverList: $("discoverList"),
  discoverSummary: $("discoverSummary"),
  discoverClose: $("discoverClose"),
  blockedList: $("blockedList"),
  blockedCount: $("blockedCount"),
  clearAllBtn: $("clearAllBtn"),
  statTotal: $("statTotal"),
  statToday: $("statToday"),
  statBlocked: $("statBlocked"),
  exportBtn: $("exportBtn"),
  importBtn: $("importBtn"),
  importFile: $("importFile"),
  resetBtn: $("resetBtn"),
  testNotifyBtn: $("testNotifyBtn"),
  toast: $("toast")
};

let blockedUsers = [];
let watchKeywords = [];
let muteKeywords = [];
let discoveredUsers = [];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await initI18n();
  applyI18n();
  applyIntervalOptions(els.intervalSelect);
  updateLangButtons(getLang());
  document.title = `${t("extTitle")} — ${t("subtitleSettings")}`;

  await loadSettings();
  renderBlockedList();
  renderChips();

  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => switchLanguage(btn.dataset.lang));
  });

  // Monitoring
  els.monitoringEnabled.addEventListener("change", onMonitoringChange);
  els.intervalSelect.addEventListener("change", onIntervalChange);
  els.customInterval.addEventListener("change", onCustomIntervalChange);

  // Notifications
  els.notificationsEnabled.addEventListener("change", () => saveToggle("notificationsEnabled", els.notificationsEnabled.checked, "notificationsOn", "notificationsOff"));
  els.soundEnabled.addEventListener("change", () => saveToggle("soundEnabled", els.soundEnabled.checked, "soundOn", "soundOff"));
  els.requireInteraction.addEventListener("change", () => saveToggle("requireInteraction", els.requireInteraction.checked, "persistentOn", "persistentOff"));
  els.notifyBlocked.addEventListener("change", onNotifyBlockedChange);
  els.previewLength.addEventListener("input", onPreviewLengthInput);
  els.previewLength.addEventListener("change", onPreviewLengthChange);
  els.badgeColor.addEventListener("change", onBadgeColorChange);
  els.quietHoursEnabled.addEventListener("change", onQuietToggle);
  els.quietStart.addEventListener("change", onQuietTimeChange);
  els.quietEnd.addEventListener("change", onQuietTimeChange);

  // Keywords
  els.addWatchBtn.addEventListener("click", () => addKeyword("watch", els.watchInput.value));
  els.watchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addKeyword("watch", els.watchInput.value); });
  els.addMuteBtn.addEventListener("click", () => addKeyword("mute", els.muteInput.value));
  els.muteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addKeyword("mute", els.muteInput.value); });

  // Block users
  els.addBtn.addEventListener("click", () => blockUser(els.manualUsername.value));
  els.manualUsername.addEventListener("keydown", (e) => {
    if (e.key === "Enter") blockUser(els.manualUsername.value);
  });
  els.discoverBtn.addEventListener("click", discoverUsers);
  els.userSearch.addEventListener("input", () => {
    if (discoveredUsers.length) {
      showDiscoverPanel();
      renderDiscoverResults();
    }
  });
  els.userSearch.addEventListener("focus", () => {
    if (discoveredUsers.length) showDiscoverPanel();
  });
  els.discoverClose.addEventListener("click", hideDiscoverPanel);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".discover-wrap")) hideDiscoverPanel();
  });
  els.clearAllBtn.addEventListener("click", clearAllBlocked);

  // Backup
  els.exportBtn.addEventListener("click", exportSettings);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", importSettings);
  els.resetBtn.addEventListener("click", resetAll);
  els.testNotifyBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "TEST_NOTIFICATION" });
  });

  chrome.storage.onChanged.addListener(onStorageChanged);
}

function onStorageChanged(changes, area) {
  if (area !== "local") return;

  if (changes.language) {
    initI18n().then(() => {
      applyI18n();
      applyIntervalOptions(els.intervalSelect);
      updateLangButtons(getLang());
      document.title = `${t("extTitle")} — ${t("subtitleSettings")}`;
      renderBlockedList();
      renderDiscoverResults();
      renderChips();
    });
  }

  if (changes.blockedUsers) {
    blockedUsers = normalizeList(changes.blockedUsers.newValue || []);
    renderBlockedList();
    renderDiscoverResults();
  }
  if (changes.watchKeywords) {
    watchKeywords = normalizeList(changes.watchKeywords.newValue || []);
    renderChips();
  }
  if (changes.muteKeywords) {
    muteKeywords = normalizeList(changes.muteKeywords.newValue || []);
    renderChips();
  }
  if (changes.stats) renderStats();
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "checkInterval", "monitoringEnabled", "notificationsEnabled", "soundEnabled",
    "requireInteraction", "notifyBlocked", "previewLength", "badgeColor",
    "quietHoursEnabled", "quietStart", "quietEnd",
    "watchKeywords", "muteKeywords", "blockedUsers", "stats"
  ]);

  const interval = String(data.checkInterval || 1);
  if (PRESET_INTERVALS.includes(interval)) {
    els.intervalSelect.value = interval;
  } else {
    els.intervalSelect.value = "custom";
    els.customIntervalRow.classList.remove("hidden");
  }
  els.customInterval.value = interval;

  els.monitoringEnabled.checked = data.monitoringEnabled !== false;
  els.notificationsEnabled.checked = data.notificationsEnabled !== false;
  els.soundEnabled.checked = data.soundEnabled !== false;
  els.requireInteraction.checked = data.requireInteraction !== false;
  els.notifyBlocked.checked = !!data.notifyBlocked;

  const preview = data.previewLength || 150;
  els.previewLength.value = preview;
  els.previewLengthValue.textContent = preview;

  els.badgeColor.value = data.badgeColor || "#e53935";

  els.quietHoursEnabled.checked = !!data.quietHoursEnabled;
  els.quietHoursRow.classList.toggle("hidden", !data.quietHoursEnabled);
  els.quietStart.value = data.quietStart || "22:00";
  els.quietEnd.value = data.quietEnd || "08:00";

  watchKeywords = normalizeList(data.watchKeywords || []);
  muteKeywords = normalizeList(data.muteKeywords || []);
  blockedUsers = normalizeList(data.blockedUsers || []);

  renderStats(data.stats);
}

async function switchLanguage(lang) {
  await setLanguage(lang);
  applyI18n();
  applyIntervalOptions(els.intervalSelect);
  updateLangButtons(getLang());
  document.title = `${t("extTitle")} — ${t("subtitleSettings")}`;
  renderBlockedList();
  renderDiscoverResults();
  renderChips();
  toast(t("languageChanged"));
}

async function onMonitoringChange() {
  const enabled = els.monitoringEnabled.checked;
  await chrome.runtime.sendMessage({ type: "SET_MONITORING", enabled });
  toast(enabled ? t("monitoringResumed") : t("monitoringPaused"));
}

async function onIntervalChange() {
  const value = els.intervalSelect.value;
  if (value === "custom") {
    els.customIntervalRow.classList.remove("hidden");
    els.customInterval.focus();
    return;
  }
  els.customIntervalRow.classList.add("hidden");
  const minutes = parseInt(value, 10);
  const res = await chrome.runtime.sendMessage({ type: "SET_INTERVAL", minutes });
  els.customInterval.value = res?.minutes || minutes;
  toast(t("intervalSet", { interval: formatMinutes(res?.minutes || minutes) }));
}

async function onCustomIntervalChange() {
  let minutes = parseInt(els.customInterval.value, 10);
  if (!minutes || minutes < 1) minutes = 1;
  if (minutes > 1440) minutes = 1440;
  els.customInterval.value = minutes;
  const res = await chrome.runtime.sendMessage({ type: "SET_INTERVAL", minutes });
  toast(t("intervalSet", { interval: formatMinutes(res?.minutes || minutes) }));
}

async function saveToggle(key, value, onKey, offKey) {
  await chrome.storage.local.set({ [key]: value });
  toast(value ? t(onKey) : t(offKey));
}

async function onNotifyBlockedChange() {
  await chrome.storage.local.set({ notifyBlocked: els.notifyBlocked.checked });
  toast(els.notifyBlocked.checked ? t("notifyBlockedOn") : t("notifyBlockedOff"));
}

function onPreviewLengthInput() {
  els.previewLengthValue.textContent = els.previewLength.value;
}

async function onPreviewLengthChange() {
  await chrome.storage.local.set({ previewLength: parseInt(els.previewLength.value, 10) });
  toast(t("previewSet", { n: els.previewLength.value }));
}

async function onBadgeColorChange() {
  await chrome.runtime.sendMessage({ type: "SET_BADGE_COLOR", color: els.badgeColor.value });
  toast(t("badgeColorUpdated"));
}

async function onQuietToggle() {
  const on = els.quietHoursEnabled.checked;
  els.quietHoursRow.classList.toggle("hidden", !on);
  await chrome.storage.local.set({ quietHoursEnabled: on });
  toast(on ? t("quietHoursOn", { start: els.quietStart.value, end: els.quietEnd.value }) : t("quietHoursOff"));
}

async function onQuietTimeChange() {
  await chrome.storage.local.set({ quietStart: els.quietStart.value, quietEnd: els.quietEnd.value });
  toast(t("quietHoursOn", { start: els.quietStart.value, end: els.quietEnd.value }));
}

function normalizeUsername(name) {
  return (name || "").trim().replace(/^@/, "");
}

function normalizeList(list) {
  return [...new Set(list.map(normalizeUsername).filter(Boolean))];
}

function isBlocked(name) {
  const key = normalizeUsername(name).toLowerCase();
  return blockedUsers.some((u) => u.toLowerCase() === key);
}

async function saveBlocked() {
  blockedUsers = normalizeList(blockedUsers);
  await chrome.storage.local.set({ blockedUsers });
  renderBlockedList();
  renderDiscoverResults();
}

async function blockUser(raw) {
  const name = normalizeUsername(raw);
  if (!name) return;

  if (isBlocked(name)) {
    toast(t("alreadyBlocked", { name }));
    return;
  }

  blockedUsers.push(name);
  await saveBlocked();
  els.manualUsername.value = "";
  toast(t("blockedName", { name }));
}

async function unblockUser(name) {
  const key = name.toLowerCase();
  blockedUsers = blockedUsers.filter((u) => u.toLowerCase() !== key);
  await saveBlocked();
  toast(t("unblockedName", { name }));
}

async function clearAllBlocked() {
  if (!blockedUsers.length) return;
  if (!confirm(t("clearBlockedConfirm", { n: blockedUsers.length }))) return;
  blockedUsers = [];
  await saveBlocked();
  toast(t("blockedListCleared"));
}

function renderBlockedList() {
  els.blockedCount.textContent = blockedUsers.length;
  if (els.statBlocked) els.statBlocked.textContent = blockedUsers.length;
  els.clearAllBtn.classList.toggle("hidden", blockedUsers.length === 0);

  if (!blockedUsers.length) {
    els.blockedList.innerHTML = `<li class="empty-state">${escapeHtml(t("noBlockedUsers"))}</li>`;
    return;
  }

  els.blockedList.innerHTML = blockedUsers
    .sort((a, b) => a.localeCompare(b))
    .map(
      (name) => `
      <li>
        <span class="username">${escapeHtml(name)}</span>
        <button class="link-btn danger" data-unblock="${escapeAttr(name)}">${escapeHtml(t("unblock"))}</button>
      </li>`
    )
    .join("");

  els.blockedList.querySelectorAll("[data-unblock]").forEach((btn) => {
    btn.addEventListener("click", () => unblockUser(btn.dataset.unblock));
  });
}

function extractUsersFromHTML(html) {
  const counts = new Map();
  const profileRegex = /\/webparty\/profile\/([^"\/\?#]+)/g;
  let match;

  while ((match = profileRegex.exec(html)) !== null) {
    const name = decodeURIComponent(match[1]);
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, posts]) => ({ name, posts }))
    .sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name));
}

async function discoverUsers() {
  els.discoverBtn.classList.add("loading");
  els.discoverBtn.disabled = true;

  try {
    const response = await fetch(TARGET_URL, {
      cache: "no-store",
      headers: { Accept: "text/html" }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    discoveredUsers = extractUsersFromHTML(html);

    if (!discoveredUsers.length) {
      toast(t("noUsersFound"));
      return;
    }

    els.discoverResults.classList.remove("hidden");
    els.discoverResults.setAttribute("aria-hidden", "false");
    renderDiscoverResults();
  } catch (err) {
    console.error(err);
    toast(t("loadUsersFailed"));
  } finally {
    els.discoverBtn.classList.remove("loading");
    els.discoverBtn.disabled = false;
  }
}

function showDiscoverPanel() {
  if (!discoveredUsers.length) return;
  els.discoverResults.classList.remove("hidden");
  els.discoverResults.setAttribute("aria-hidden", "false");
}

function hideDiscoverPanel() {
  els.discoverResults.classList.add("hidden");
  els.discoverResults.setAttribute("aria-hidden", "true");
}

function renderDiscoverResults() {
  if (!discoveredUsers.length) {
    hideDiscoverPanel();
    return;
  }

  const query = els.userSearch.value.trim().toLowerCase();
  const filtered = query
    ? discoveredUsers.filter((u) => u.name.toLowerCase().includes(query))
    : discoveredUsers;

  const shown = filtered.slice(0, 80);
  els.discoverSummary.textContent = query
    ? t("discoverFiltered", { shown: shown.length, total: discoveredUsers.length })
    : t("foundUsers", { n: discoveredUsers.length });

  if (!shown.length) {
    els.discoverList.innerHTML = `<div class="discover-empty">${escapeHtml(t("noSearchMatch"))}</div>`;
    showDiscoverPanel();
    return;
  }

  els.discoverList.innerHTML = shown
    .map(({ name, posts }) => {
      const blocked = isBlocked(name);
      const initial = escapeHtml(name.charAt(0).toUpperCase());
      const meta = posts === 1 ? t("postOnPage") : t("postsOnPage", { n: posts });
      return `
      <div class="discover-item${blocked ? " is-blocked" : ""}">
        <span class="discover-avatar">${initial}</span>
        <div class="discover-item-main">
          <span class="name">${escapeHtml(name)}</span>
          <span class="meta">${escapeHtml(meta)}</span>
        </div>
        <div class="actions">
          ${
            blocked
              ? `<button class="btn secondary small" data-unblock-discover="${escapeAttr(name)}">${escapeHtml(t("unblock"))}</button>`
              : `<button class="btn primary small" data-block-discover="${escapeAttr(name)}">${escapeHtml(t("block"))}</button>`
          }
        </div>
      </div>`;
    })
    .join("");

  els.discoverList.querySelectorAll("[data-block-discover]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      blockUser(btn.dataset.blockDiscover);
    });
  });

  els.discoverList.querySelectorAll("[data-unblock-discover]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      unblockUser(btn.dataset.unblockDiscover);
    });
  });

  showDiscoverPanel();
}

// ---- KEYWORDS ----
function keywordState(kind) {
  return kind === "watch"
    ? { list: watchKeywords, key: "watchKeywords", input: els.watchInput }
    : { list: muteKeywords, key: "muteKeywords", input: els.muteInput };
}

async function addKeyword(kind, raw) {
  const word = (raw || "").trim();
  if (!word) return;
  const state = keywordState(kind);
  if (state.list.some((k) => k.toLowerCase() === word.toLowerCase())) {
    toast(t("keywordExists", { word }));
    return;
  }
  state.list.push(word);
  await chrome.storage.local.set({ [state.key]: normalizeList(state.list) });
  if (kind === "watch") watchKeywords = normalizeList(state.list);
  else muteKeywords = normalizeList(state.list);
  state.input.value = "";
  renderChips();
  toast(t("keywordAdded", { word }));
}

async function removeKeyword(kind, word) {
  const state = keywordState(kind);
  const next = state.list.filter((k) => k.toLowerCase() !== word.toLowerCase());
  if (kind === "watch") watchKeywords = next; else muteKeywords = next;
  await chrome.storage.local.set({ [state.key]: next });
  renderChips();
  toast(t("keywordRemoved", { word }));
}

function renderChips() {
  renderChipList(els.watchChips, watchKeywords, "watch", t("noWatchKeywords"));
  renderChipList(els.muteChips, muteKeywords, "mute", t("noMuteKeywords"));
}

function renderChipList(container, list, kind, emptyText) {
  if (!list.length) {
    container.innerHTML = `<span class="chip-empty">${emptyText}</span>`;
    return;
  }
  container.innerHTML = list
    .map((word) => `
      <span class="chip ${kind}">
        ${escapeHtml(word)}
        <button class="chip-x" data-kind="${kind}" data-word="${escapeAttr(word)}" title="${escapeAttr(t("remove"))}">×</button>
      </span>`)
    .join("");
  container.querySelectorAll(".chip-x").forEach((btn) => {
    btn.addEventListener("click", () => removeKeyword(btn.dataset.kind, btn.dataset.word));
  });
}

// ---- STATS ----
async function renderStats(stats) {
  if (!stats) {
    const data = await chrome.storage.local.get("stats");
    stats = data.stats;
  }
  const today = new Date().toISOString().slice(0, 10);
  els.statTotal.textContent = stats?.totalDetected || 0;
  els.statToday.textContent = stats?.day === today ? (stats.todayCount || 0) : 0;
  els.statBlocked.textContent = blockedUsers.length;
}

// ---- BACKUP / RESTORE ----
async function exportSettings() {
  const keys = [
    "checkInterval", "monitoringEnabled", "notificationsEnabled", "soundEnabled",
    "requireInteraction", "notifyBlocked", "previewLength", "badgeColor",
    "quietHoursEnabled", "quietStart", "quietEnd",
    "watchKeywords", "muteKeywords", "blockedUsers", "language"
  ];
  const data = await chrome.storage.local.get(keys);
  const payload = { app: "pohoda-webparty-monitor", version: 4, exportedAt: new Date().toISOString(), settings: data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pohoda-monitor-settings-${today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(t("settingsExported"));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function importSettings(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const settings = parsed.settings || parsed;
    if (typeof settings !== "object") throw new Error("Invalid file");

    if (Array.isArray(settings.blockedUsers)) settings.blockedUsers = normalizeList(settings.blockedUsers);
    if (Array.isArray(settings.watchKeywords)) settings.watchKeywords = normalizeList(settings.watchKeywords);
    if (Array.isArray(settings.muteKeywords)) settings.muteKeywords = normalizeList(settings.muteKeywords);

    await chrome.storage.local.set(settings);
    if (settings.checkInterval) await chrome.runtime.sendMessage({ type: "SET_INTERVAL", minutes: settings.checkInterval });
    if (settings.badgeColor) await chrome.runtime.sendMessage({ type: "SET_BADGE_COLOR", color: settings.badgeColor });

    await loadSettings();
    await initI18n();
    applyI18n();
    applyIntervalOptions(els.intervalSelect);
    updateLangButtons(getLang());
    renderBlockedList();
    renderChips();
    toast(t("settingsImported"));
  } catch (err) {
    console.error(err);
    toast(t("importFailed"));
  } finally {
    e.target.value = "";
  }
}

async function resetAll() {
  if (!confirm(t("resetConfirm"))) return;
  const defaults = {
    checkInterval: 1, monitoringEnabled: true, notificationsEnabled: true, soundEnabled: true,
    requireInteraction: true, notifyBlocked: false, previewLength: 150,
    badgeColor: "#e53935", quietHoursEnabled: false, quietStart: "22:00",
    quietEnd: "08:00", watchKeywords: [], muteKeywords: [], blockedUsers: [], language: "sk"
  };
  await chrome.storage.local.set(defaults);
  await setLanguage("sk");
  await chrome.runtime.sendMessage({ type: "SET_INTERVAL", minutes: 1 });
  await chrome.runtime.sendMessage({ type: "SET_BADGE_COLOR", color: "#e53935" });
  await loadSettings();
  await initI18n();
  applyI18n();
  applyIntervalOptions(els.intervalSelect);
  updateLangButtons(getLang());
  renderBlockedList();
  renderChips();
  toast(t("allReset"));
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

const TARGET_URL = "https://www.pohodafestival.sk/webparty";

const elements = {
  lastCheck: document.getElementById("lastCheck"),
  postUser: document.getElementById("postUser"),
  postDate: document.getElementById("postDate"),
  postContent: document.getElementById("postContent"),
  checkBtn: document.getElementById("checkBtn"),
  openBtn: document.getElementById("openBtn"),
  clearBtn: document.getElementById("clearBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  spinner: document.getElementById("spinner"),
  badge: document.getElementById("badge"),
  statusDot: document.getElementById("statusDot"),
  monitorState: document.getElementById("monitorState"),
  monitorToggle: document.getElementById("monitorToggle"),
  statToday: document.getElementById("statToday"),
  statTotal: document.getElementById("statTotal"),
  historySection: document.getElementById("historySection"),
  toggleHistory: document.getElementById("toggleHistory"),
  historyList: document.getElementById("historyList")
};

document.addEventListener("DOMContentLoaded", initPopup);

async function initPopup() {
  await initI18n();
  applyI18n();
  await clearBadge();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.language) {
      initI18n().then(() => {
        applyI18n();
        loadStatus();
      });
    }
  });
  await refreshPosts(true);
}

async function refreshPosts(silent = false) {
  if (!silent) {
    elements.checkBtn.classList.add("loading");
    elements.checkBtn.disabled = true;
  }

  try {
    await chrome.runtime.sendMessage({ type: "MANUAL_CHECK" });
    await loadStatus();
  } catch (err) {
    console.error("Failed to refresh posts:", err);
  } finally {
    if (!silent) {
      elements.checkBtn.classList.remove("loading");
      elements.checkBtn.disabled = false;
    }
  }
}

async function loadStatus() {
  try {
    const data = await chrome.runtime.sendMessage({ type: "GET_STATUS" });

    if (data.lastCheck) {
      elements.lastCheck.textContent = getTimeAgo(data.lastCheck);
    }

    if (data.lastPost) {
      elements.postUser.textContent = data.lastPost.user;
      elements.postDate.textContent = data.lastPost.date;
      elements.postContent.textContent = truncate(data.lastPost.content, 200);
    } else {
      elements.postContent.textContent = t("noPostsYet");
    }

    if (data.count > 0) {
      elements.badge.textContent = data.count;
      elements.badge.style.display = "inline-block";
    } else {
      elements.badge.style.display = "none";
      elements.badge.textContent = "";
    }

    if (data.blockedCount > 0) {
      elements.postUser.title = t("blockedUsersHint", { count: data.blockedCount });
    }

    updateMonitorState(data.monitoringEnabled !== false);
    renderStats(data.stats);
    renderHistory(data.postHistory || []);
  } catch (err) {
    console.error("Failed to load status:", err);
  }
}

function updateMonitorState(enabled) {
  elements.monitorToggle.checked = enabled;
  elements.monitorState.textContent = enabled ? t("active") : t("paused");
  elements.statusDot.classList.toggle("paused", !enabled);
}

function renderStats(stats) {
  const today = new Date().toISOString().slice(0, 10);
  elements.statTotal.textContent = stats?.totalDetected || 0;
  elements.statToday.textContent = stats?.day === today ? (stats.todayCount || 0) : 0;
}

function renderHistory(history) {
  if (!history.length) {
    elements.historyList.innerHTML = `<li class="history-empty">${escapeHtml(t("noHistory"))}</li>`;
    return;
  }

  elements.historyList.innerHTML = history
    .slice(0, 15)
    .map((p) => `
      <li class="history-item${p.watched ? " watched" : ""}" data-id="${escapeAttr(p.id)}">
        <div class="history-top">
          <span class="history-user">${p.watched ? "🔔 " : ""}${escapeHtml(p.user)}</span>
          <span class="history-date">${escapeHtml(p.date)}</span>
        </div>
        <div class="history-text">${escapeHtml(truncate(p.content, 90))}</div>
      </li>`)
    .join("");

  elements.historyList.querySelectorAll(".history-item").forEach((li) => {
    li.addEventListener("click", () => {
      const id = li.dataset.id;
      const url = id && id.startsWith("comment") ? `${TARGET_URL}#${id}` : TARGET_URL;
      chrome.tabs.create({ url });
      window.close();
    });
  });
}

elements.checkBtn.addEventListener("click", () => refreshPosts(false));

elements.monitorToggle.addEventListener("change", async () => {
  const enabled = elements.monitorToggle.checked;
  updateMonitorState(enabled);
  await chrome.runtime.sendMessage({ type: "SET_MONITORING", enabled });
  if (enabled) loadStatus();
});

elements.toggleHistory.addEventListener("click", () => {
  const hidden = elements.historyList.classList.toggle("hidden");
  elements.toggleHistory.textContent = hidden ? t("show") : t("hide");
});

elements.openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: TARGET_URL });
  window.close();
});

elements.settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

elements.clearBtn.addEventListener("click", clearBadge);

async function clearBadge() {
  await chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
  elements.badge.style.display = "none";
  elements.badge.textContent = "";
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return t("justNow");
  if (seconds < 3600) return t("minutesAgo", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("hoursAgo", { n: Math.floor(seconds / 3600) });
  return new Date(timestamp).toLocaleDateString(getLang() === "sk" ? "sk-SK" : "en-GB");
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
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

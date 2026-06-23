const TARGET_URL = "https://www.pohodafestival.sk/webparty";
const HISTORY_LIMIT = 30;

// Central default settings — single source of truth.
const DEFAULTS = {
  checkInterval: 1,            // minutes between background checks
  blockedUsers: [],            // usernames whose message text is hidden
  monitoringEnabled: true,     // master on/off switch for background checks
  notificationsEnabled: true,  // show desktop notifications for new posts
  soundEnabled: true,          // play alert sound for new posts
  notifyBlocked: false,        // notify even for blocked users
  requireInteraction: true,    // keep notification on screen until dismissed
  previewLength: 150,          // characters of post content shown in notification
  badgeColor: "#e53935",       // unread-count badge color
  quietHoursEnabled: false,    // suppress notifications during a time window
  quietStart: "22:00",         // quiet hours start (HH:MM, 24h)
  quietEnd: "08:00",           // quiet hours end (HH:MM, 24h)
  watchKeywords: [],           // posts containing these always notify (priority)
  muteKeywords: [],            // posts containing these are hidden + never notify
  language: "sk",              // ui language: sk (default) or en
  stats: { totalDetected: 0, todayCount: 0, day: "" }
};

const SETTING_KEYS = Object.keys(DEFAULTS);

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const settings = { ...DEFAULTS };
  for (const key of SETTING_KEYS) {
    if (stored[key] !== undefined) settings[key] = stored[key];
  }
  return settings;
}

async function ensureCheckAlarm() {
  const existing = await chrome.alarms.get("checkPosts");
  if (existing) return;

  const { checkInterval } = await chrome.storage.local.get("checkInterval");
  const minutes = Math.min(
    Math.max(parseInt(checkInterval, 10) || DEFAULTS.checkInterval, 1),
    1440
  );
  await chrome.alarms.create("checkPosts", { periodInMinutes: minutes });
}

// INIT — seed any missing defaults without clobbering existing values.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  const toSet = {};
  for (const key of SETTING_KEYS) {
    if (stored[key] === undefined) toSet[key] = DEFAULTS[key];
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);

  await ensureCheckAlarm();
  chrome.action.setBadgeBackgroundColor({ color: stored.badgeColor || DEFAULTS.badgeColor });

  runCheck();
});

// Check for new posts when browser starts
chrome.runtime.onStartup.addListener(async () => {
  await ensureCheckAlarm();
  runCheck();
});

async function isUserBlocked(username) {
  const { blockedUsers = [] } = await chrome.storage.local.get("blockedUsers");
  const key = (username || "").toLowerCase();
  return blockedUsers.some((u) => u.toLowerCase() === key);
}

// ALARM LOOP
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkPosts") {
    runCheck();
  }
});

// UPDATE CHECK INTERVAL
async function updateCheckInterval(minutes) {
  const clamped = Math.min(Math.max(parseInt(minutes, 10) || DEFAULTS.checkInterval, 1), 1440);
  await chrome.alarms.clear("checkPosts");
  await chrome.alarms.create("checkPosts", { periodInMinutes: clamped });
  await chrome.storage.local.set({ checkInterval: clamped });
  console.log(`[Pohoda Monitor] Check interval updated to ${clamped} min`);
  return clamped;
}

// Is the current local time inside the quiet-hours window?
function inQuietHours(start, end) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e; // handle overnight wrap
}

// Does text contain any of the keywords (case-insensitive)?
function matchesKeyword(text, keywords) {
  if (!keywords || !keywords.length) return false;
  const lower = (text || "").toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

// PARSE HTML AND EXTRACT NEWEST POST (regex — works in service workers without DOMParser)
function extractPostFromHTML(html) {
  const blocks = findCommentBlocks(html);
  let newestPost = null;
  let newestDate = 0;
  let newestCommentNum = 0;

  for (const block of blocks) {
    const post = parseCommentBlock(block);
    if (!post) continue;

    const isNewer =
      post.commentNum > newestCommentNum ||
      (post.commentNum === newestCommentNum && post.timestamp > newestDate);

    if (isNewer) {
      newestPost = post;
      newestDate = post.timestamp;
      newestCommentNum = post.commentNum;
    }
  }

  return newestPost;
}

/** Extract each li#comment block, handling nested reply li elements */
function findCommentBlocks(html) {
  const blocks = [];
  const re = /<li id="comment(\d+)"[^>]*>/gi;
  let m;

  while ((m = re.exec(html)) !== null) {
    const commentNum = parseInt(m[1], 10);
    const id = `comment${m[1]}`;
    const contentStart = m.index + m[0].length;
    let depth = 1;
    let i = contentStart;

    while (depth > 0 && i < html.length) {
      const openIdx = html.indexOf("<li", i);
      const closeIdx = html.indexOf("</li>", i);
      if (closeIdx === -1) break;

      const openIsLi =
        openIdx !== -1 &&
        openIdx < closeIdx &&
        /[\s>]/.test(html.charAt(openIdx + 3));

      if (openIsLi) {
        depth++;
        i = openIdx + 4;
      } else {
        depth--;
        if (depth === 0) {
          blocks.push({ id, commentNum, html: html.slice(contentStart, closeIdx) });
        }
        i = closeIdx + 5;
      }
    }
  }

  return blocks;
}

function parseCommentBlock({ id, commentNum, html }) {
  const headerMatch = html.match(/class="thread-header"[^>]*>([\s\S]*?)<\/p/i);
  if (!headerMatch) return null;

  const userMatch = headerMatch[1].match(/\/webparty\/profile\/[^"]+"[^>]*>([^<]+)</);
  const user = userMatch ? decodeURIComponent(userMatch[1].trim()) : "Unknown";

  const datePattern = /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4},?\s*\d{1,2}:\d{2})/;
  const dateMatch = stripHtml(headerMatch[1]).match(datePattern);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1].trim();
  const timestamp = parseDate(dateStr);

  const contentMatch = html.match(/class="thread-content"[^>]*>([\s\S]*?)<\/p/i);
  if (!contentMatch) return null;

  let content = stripHtml(contentMatch[1]).trim();
  content = content.replace(/\s*Odpovedať\s*/g, "").trim();
  if (!content) return null;

  return { user, date: dateStr, content, id, timestamp, commentNum };
}

// Parse date string like "17. 3. 2026, 11:33" to timestamp
function parseDate(dateStr) {
  try {
    // Format: "DD. M. YYYY, HH:MM"
    const match = dateStr.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4}),?\s*(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    
    const [, day, month, year, hour, minute] = match;
    return new Date(year, month - 1, day, hour, minute).getTime();
  } catch {
    return 0;
  }
}

// Extract last word from text (likely username)
function extractLastWord(text) {
  const words = text.trim().split(/\s+/);
  const lastWord = words[words.length - 1] || "Unknown";
  return lastWord.replace(/[^a-zA-Z0-9_]/g, '') || "Unknown";
}

// Remove HTML tags and decode entities
function stripHtml(html) {
  let text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  
  // Decode named HTML entities for Slovak diacritics
  const entities = {
    '&aacute;': 'á', '&Aacute;': 'Á',
    '&auml;': 'ä', '&Auml;': 'Ä',
    '&ccaron;': 'č', '&Ccaron;': 'Č',
    '&dcaron;': 'ď', '&Dcaron;': 'Ď',
    '&eacute;': 'é', '&Eacute;': 'É',
    '&ecaron;': 'ě', '&Ecaron;': 'Ě',
    '&iacute;': 'í', '&Iacute;': 'Í',
    '&lcaron;': 'ľ', '&Lcaron;': 'Ľ',
    '&ncaron;': 'ň', '&Ncaron;': 'Ň',
    '&oacute;': 'ó', '&Oacute;': 'Ó',
    '&ocaron;': 'ô', '&Ocaron;': 'Ô',
    '&racute;': 'ŕ', '&Racute;': 'Ŕ',
    '&rcaron;': 'ř', '&Rcaron;': 'Ř',
    '&scaron;': 'š', '&Scaron;': 'Š',
    '&tcaron;': 'ť', '&Tcaron;': 'Ť',
    '&uacute;': 'ú', '&Uacute;': 'Ú',
    '&uuml;': 'ü', '&Uuml;': 'Ü',
    '&yacute;': 'ý', '&Yacute;': 'Ý',
    '&zcaron;': 'ž', '&Zcaron;': 'Ž'
  };
  
  for (const [entity, char] of Object.entries(entities)) {
    text = text.replace(new RegExp(entity, 'gi'), char);
  }
  
  // Decode numeric entities (&#225; etc)
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  text = text.replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
  
  return text.replace(/\s+/g, ' ').trim();
}

// Safe base64 encoding for service worker
function safeBase64(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return btoa(encodeURIComponent(str).replace(/%[0-9A-F]{2}/g, ''));
  }
}

const WEBPARTY_TAB_PATTERNS = [
  "https://www.pohodafestival.sk/webparty",
  "https://www.pohodafestival.sk/webparty*"
];

function isWebpartyUrl(url) {
  return !!url && /^https:\/\/www\.pohodafestival\.sk\/webparty/i.test(url);
}

async function queryWebpartyTabs() {
  const seen = new Map();
  for (const pattern of WEBPARTY_TAB_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (tab.id && isWebpartyUrl(tab.url)) seen.set(tab.id, tab);
    }
  }
  return [...seen.values()];
}

function deliverPagePopupToTab(tabId, post, attempt = 0) {
  if (!post?.id) return;

  chrome.tabs.sendMessage(tabId, { type: "SHOW_PAGE_POPUP", post }, () => {
    if (!chrome.runtime.lastError) return;

    if (attempt < 12) {
      setTimeout(() => deliverPagePopupToTab(tabId, post, attempt + 1), 200 + attempt * 150);
      return;
    }

    console.warn("[Pohoda Monitor] Page popup delivery failed:", chrome.runtime.lastError.message);
  });
}

function reloadWebpartyTab(tabId, popupPost) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      if (popupPost) deliverPagePopupToTab(tabId, popupPost);
      finish();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Pohoda Monitor] Tab reload failed:", chrome.runtime.lastError.message);
        finish();
      }
    });

    // Fallback if complete never fires (cached tab, etc.)
    setTimeout(finish, 15000);
  });
}

async function reloadWebpartyTabs(popupPost = null) {
  try {
    const tabs = await queryWebpartyTabs();

    if (!tabs.length) {
      if (popupPost) {
        console.log("[Pohoda Monitor] No open Webparty tab — popup queued until you visit Webparty");
      }
      return;
    }

    await Promise.all(
      tabs.map((tab) => (tab.id ? reloadWebpartyTab(tab.id, popupPost) : Promise.resolve()))
    );

    console.log(`[Pohoda Monitor] Reloaded ${tabs.length} Webparty tab(s)`);
  } catch (err) {
    console.warn("[Pohoda Monitor] Tab reload failed:", err);
  }
}

// Deliver queued in-page popup when user opens or navigates to Webparty.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !isWebpartyUrl(tab?.url)) return;

  chrome.storage.local.get("pagePopupPost", ({ pagePopupPost }) => {
    if (pagePopupPost?.id) deliverPagePopupToTab(tabId, pagePopupPost);
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function webpartyFetchUrl() {
  return `${TARGET_URL}?_=${Date.now()}`;
}

async function fetchWebpartyDirect(credentials = "omit") {
  const response = await fetch(webpartyFetchUrl(), {
    method: "GET",
    credentials,
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWebpartyViaTab() {
  const tabs = await queryWebpartyTabs();

  for (const tab of tabs) {
    if (!tab.id) continue;

    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_WEBPARTY_HTML" });
      if (res?.html) {
        console.log("[Pohoda Monitor] Fetched via open Webparty tab");
        return res.html;
      }
    } catch {
      // Tab may not have a live content script yet.
    }
  }

  return null;
}

async function fetchWebpartyViaHiddenTab() {
  let tabId;

  try {
    const tab = await chrome.tabs.create({
      url: webpartyFetchUrl(),
      active: false
    });
    tabId = tab.id;
    if (!tabId) return null;

    const html = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(value);
      };

      const tryFetch = (attempt = 0) => {
        chrome.tabs.sendMessage(tabId, { type: "FETCH_WEBPARTY_HTML" }, (res) => {
          if (chrome.runtime.lastError || !res?.html) {
            if (attempt < 15) {
              setTimeout(() => tryFetch(attempt + 1), 200 + attempt * 120);
              return;
            }
            finish(null);
            return;
          }
          finish(res.html);
        });
      };

      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== tabId || info.status !== "complete") return;
        tryFetch();
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(() => finish(null), 20000);
    });

    if (html) {
      console.log("[Pohoda Monitor] Fetched via temporary Webparty tab");
    }

    return html;
  } catch (err) {
    console.warn("[Pohoda Monitor] Hidden tab fetch failed:", err);
    return null;
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Tab may already be closed.
      }
    }
  }
}

async function fetchWebpartyHtml() {
  const errors = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);

    for (const credentials of ["omit", "include"]) {
      try {
        return await fetchWebpartyDirect(credentials);
      } catch (err) {
        errors.push(`${credentials}: ${err.message}`);
      }
    }
  }

  const viaTab = await fetchWebpartyViaTab();
  if (viaTab) return viaTab;

  const viaHiddenTab = await fetchWebpartyViaHiddenTab();
  if (viaHiddenTab) return viaHiddenTab;

  throw new Error(errors.join("; ") || "Failed to fetch");
}

let checkInFlight = false;
const processingPostIds = new Set();

// MAIN CHECK FUNCTION - USES FETCH (NO TAB OPENING!)
async function runCheck() {
  if (checkInFlight) {
    console.log("[Pohoda Monitor] Check already running — skipped");
    return;
  }

  checkInFlight = true;
  try {
    const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");
    if (!monitoringEnabled) {
      console.log("[Pohoda Monitor] Monitoring paused — skipping check");
      await chrome.storage.local.set({ lastCheck: Date.now() });
      return;
    }

    console.log("[Pohoda Monitor] Checking for new posts...");

    const html = await fetchWebpartyHtml();
    const post = extractPostFromHTML(html);

    if (!post) {
      console.warn("[Pohoda Monitor] No post found on page");
      await chrome.storage.local.set({ lastCheck: Date.now(), lastCheckError: "no_post_found" });
      return;
    }

    await chrome.storage.local.remove("lastCheckError");
    await processPost(post);
  } catch (err) {
    console.error("[Pohoda Monitor] Check error:", err);
    await chrome.storage.local.set({
      lastCheck: Date.now(),
      lastCheckError: String(err.message || err)
    });
  } finally {
    checkInFlight = false;
  }
}

// Update aggregate statistics, resetting the daily counter at midnight.
function bumpStats(stats) {
  const today = new Date().toISOString().slice(0, 10);
  const next = { ...DEFAULTS.stats, ...(stats || {}) };
  if (next.day !== today) {
    next.day = today;
    next.todayCount = 0;
  }
  next.totalDetected += 1;
  next.todayCount += 1;
  return next;
}

// PROCESS EXTRACTED POST DATA
async function processPost(post, opts = {}) {
  if (!post?.id) return;

  if (processingPostIds.has(post.id)) return;
  processingPostIds.add(post.id);

  try {
    const settings = await getSettings();
    const { lastPostId, count = 0, postHistory = [] } =
      await chrome.storage.local.get(["lastPostId", "count", "postHistory"]);

    // Always refresh latest post display + check time
    await chrome.storage.local.set({
      lastPost: post,
      lastCheck: Date.now()
    });

    // FIRST RUN → SAVE BUT DO NOT NOTIFY
    if (!lastPostId) {
      await chrome.storage.local.set({ lastPostId: post.id, count: 0 });
      console.log("[Pohoda Monitor] First run - baseline saved");
      return;
    }

    if (lastPostId === post.id) {
      console.log("[Pohoda Monitor] No new posts");
      return;
    }

    // NEW POST DETECTED
    console.log("[Pohoda Monitor] New post detected!");

    const blocked = await isUserBlocked(post.user);
    const muted = matchesKeyword(post.content, settings.muteKeywords);
    const watched = matchesKeyword(post.content, settings.watchKeywords);
    const quiet = settings.quietHoursEnabled &&
      inQuietHours(settings.quietStart, settings.quietEnd);

    // Prepend to capped history (skip muted posts).
    if (!muted) {
      const history = [{ ...post, watched, seenAt: Date.now() }, ...postHistory]
        .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
        .slice(0, HISTORY_LIMIT);
      await chrome.storage.local.set({ postHistory: history });
    }

    // Update statistics.
    await chrome.storage.local.set({ stats: bumpStats(settings.stats) });

    // Decide whether to alert (shared rules for notification + sound + badge + popup).
    const allowedByBlock = !blocked || settings.notifyBlocked;
    const shouldAlert = !muted && allowedByBlock && (watched || !quiet);
    const shouldNotifyDesktop = shouldAlert && settings.notificationsEnabled;
    const shouldPlaySound = shouldAlert && settings.soundEnabled;

    if (shouldAlert) {
      await updateBadge(count + 1, settings.badgeColor);
    }

    if (shouldNotifyDesktop) {
      await notify(post, { watched, previewLength: settings.previewLength, requireInteraction: settings.requireInteraction });
    }

    if (shouldPlaySound) {
      playNotificationSound();
    }

    if (!shouldAlert) {
      const reason = muted
        ? "muted keyword"
        : blocked && !settings.notifyBlocked
          ? "blocked user"
          : quiet && !watched
            ? "quiet hours"
            : "unknown";
      console.log(`[Pohoda Monitor] Skipped alert — ${reason}`);
    } else if (!shouldNotifyDesktop && !shouldPlaySound) {
      console.log("[Pohoda Monitor] Badge updated — desktop notification and sound off");
    }

    const pagePopupPost = shouldAlert
      ? {
          id: post.id,
          user: post.user,
          date: post.date,
          content: post.content,
          watched,
          at: Date.now()
        }
      : null;

    await chrome.storage.local.set({
      lastPostId: post.id,
      highlightPostId: post.id,
      pagePopupPost
    });

    if (opts.skipTabReload) {
      if (pagePopupPost && opts.sourceTabId) {
        deliverPagePopupToTab(opts.sourceTabId, pagePopupPost);
      }
    } else {
      await reloadWebpartyTabs(pagePopupPost);
    }
  } catch (err) {
    console.error("[Pohoda Monitor] Process error:", err);
  } finally {
    processingPostIds.delete(post.id);
  }
}

// HANDLE MESSAGES FROM POPUP
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MANUAL_CHECK") {
    runCheck().then(() => sendResponse({ success: true }));
    return true; // Keep channel open for async response
  }

  if (msg.type === "REPORT_NEW_POST" && msg.post?.id) {
    processPost(msg.post, {
      skipTabReload: true,
      sourceTabId: sender.tab?.id
    }).then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (msg.type === "GET_STATUS") {
    chrome.storage.local
      .get(["lastPost", "lastCheck", "count", "checkInterval", "blockedUsers", "monitoringEnabled", "postHistory", "stats"])
      .then((data) => {
        sendResponse({
          ...data,
          blockedCount: (data.blockedUsers || []).length,
          monitoringEnabled: data.monitoringEnabled !== false
        });
      });
    return true;
  }
  
  if (msg.type === "SET_INTERVAL") {
    updateCheckInterval(msg.minutes).then((minutes) => sendResponse({ success: true, minutes }));
    return true;
  }

  if (msg.type === "SET_MONITORING") {
    chrome.storage.local.set({ monitoringEnabled: !!msg.enabled }).then(() => {
      if (msg.enabled) runCheck();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "SET_BADGE_COLOR") {
    chrome.action.setBadgeBackgroundColor({ color: msg.color || DEFAULTS.badgeColor });
    chrome.storage.local.set({ badgeColor: msg.color || DEFAULTS.badgeColor });
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === "CLEAR_HISTORY") {
    chrome.storage.local.set({ postHistory: [] }).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === "CLEAR_BADGE") {
    updateBadge(0).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === "TEST_NOTIFICATION") {
    notify(
      {
        user: "Test",
        date: new Date().toLocaleString("sk-SK"),
        content: "Ak vidíte túto správu, notifikácie fungujú.",
        id: "comment_test"
      },
      { previewLength: 150, requireInteraction: false }
    );
    playNotificationSound({ force: true });
    sendResponse({ success: true });
    return true;
  }
});

// NOTIFICATION SOUND (via offscreen document — service workers cannot play audio)
async function updateBadge(count, color) {
  const next = Math.max(0, parseInt(count, 10) || 0);
  await chrome.action.setBadgeBackgroundColor({ color: color || DEFAULTS.badgeColor });
  await chrome.action.setBadgeText({ text: next > 0 ? String(next) : "" });
  await chrome.storage.local.set({ count: next });
}

async function playNotificationSound(opts = {}) {
  const settings = await getSettings();
  if (!opts.force && settings.soundEnabled === false) return;

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Play alert sound when a new Webparty post is detected"
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  } catch {
    // Offscreen document already exists.
  }

  try {
    await chrome.runtime.sendMessage({ type: "PLAY_NOTIFICATION_SOUND" });
  } catch (err) {
    console.warn("[Pohoda Monitor] Sound failed:", err);
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}

// NOTIFICATION
function notify(post, opts = {}) {
  const { watched = false, previewLength = 150, requireInteraction = true } = opts;
  const notificationId = `pohoda_${post.id || Date.now()}`;

  const len = Math.max(20, parseInt(previewLength, 10) || 150);
  const preview = post.content.length > len
    ? post.content.slice(0, len) + "..."
    : post.content;

  const options = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/pohodalogo.png"),
    title: `${watched ? "🔔 " : ""}${post.user}`,
    message: `${post.date} — ${preview}`,
    priority: 2,
    requireInteraction: !!requireInteraction
  };

  return new Promise((resolve) => {
    chrome.notifications.create(notificationId, options, () => {
      if (chrome.runtime.lastError) {
        console.error("[Pohoda Monitor] Notification failed:", chrome.runtime.lastError.message);
        const { iconUrl, ...fallback } = options;
        chrome.notifications.create(`${notificationId}_fallback`, fallback, () => {
          if (chrome.runtime.lastError) {
            console.error("[Pohoda Monitor] Notification fallback failed:", chrome.runtime.lastError.message);
          } else {
            console.log("[Pohoda Monitor] Notification shown (no icon)");
          }
          resolve();
        });
        return;
      }
      console.log("[Pohoda Monitor] Notification shown:", notificationId);
      resolve();
    });
  });
}

function openPostFromNotification(notificationId) {
  const id = (notificationId || "").replace(/^pohoda_/, "");
  const url = id && id.startsWith("comment") ? `${TARGET_URL}#${id}` : TARGET_URL;
  chrome.tabs.create({ url });
  chrome.action.setBadgeText({ text: "" });
  chrome.storage.local.set({ count: 0 });
}

// CLICK NOTIFICATION → OPEN EXACT POST + CLEAR BADGE
chrome.notifications.onClicked.addListener((notificationId) => {
  openPostFromNotification(notificationId);
  chrome.notifications.clear(notificationId);
});

// CLOSE NOTIFICATION → CLEAR BADGE (user read it)
chrome.notifications.onClosed.addListener((notificationId) => {
  if (!String(notificationId || "").startsWith("pohoda_")) return;
  chrome.action.setBadgeText({ text: "" });
  chrome.storage.local.set({ count: 0 });
});

ensureCheckAlarm().catch((err) => {
  console.warn("[Pohoda Monitor] Failed to ensure alarm:", err);
});
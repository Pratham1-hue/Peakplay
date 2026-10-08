/**
 * service_worker.js — PeakPlay background (Manifest V3).
 * Holds defaults, badge state, and message relay.
 */

const DEFAULTS = { enabled: true, k: 0.5, contextEnabled: true, maxSkipSec: 45, contextKeepSec: 8, gentleSkips: true };

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(DEFAULTS, (items) => {
    const patch = {};
    if (items.enabled === undefined) patch.enabled = DEFAULTS.enabled;
    if (!Number.isFinite(Number(items.k))) patch.k = DEFAULTS.k;
    if (items.contextEnabled === undefined) patch.contextEnabled = DEFAULTS.contextEnabled;
    if (!Number.isFinite(Number(items.maxSkipSec))) patch.maxSkipSec = DEFAULTS.maxSkipSec;
    if (!Number.isFinite(Number(items.contextKeepSec))) patch.contextKeepSec = DEFAULTS.contextKeepSec;
    if (items.gentleSkips === undefined) patch.gentleSkips = DEFAULTS.gentleSkips;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
  if (details.reason === 'install') {
    console.log('[PeakPlay] installed. Defaults:', DEFAULTS);
  }
});

// Keep badge in sync when popup writes stats (optional key).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.badgeText) {
    const text = String(changes.badgeText.newValue || '').slice(0, 4);
    chrome.action.setBadgeText({ text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#0f9d58' }).catch(() => {});
  }
});

// Alt+S toggles globally: content scripts pick it up via storage.onChanged.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-peakplay') return;
  chrome.storage.local.get({ enabled: true }, (items) => {
    chrome.storage.local.set({ enabled: !(items.enabled !== false) });
  });
});

// Allow content scripts to ask for defaults even before storage read.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'PEAKPLAY_GET_DEFAULTS') {
    chrome.storage.local.get(DEFAULTS, (items) => {
      sendResponse({ enabled: items.enabled !== false, k: Number(items.k) || 0.5 });
    });
    return true;
  }

  if (msg.type === 'PEAKPLAY_SET_BADGE') {
    const text = String(msg.text || '').slice(0, 4);
    if (sender.tab && sender.tab.id !== undefined) {
      chrome.action.setBadgeText({ text, tabId: sender.tab.id }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#0f9d58' }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

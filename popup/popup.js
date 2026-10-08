/**
 * popup.js — PeakPlay popup controller.
 */
(function () {
  'use strict';

  var enabledToggle = document.getElementById('enabledToggle');
  var kSlider = document.getElementById('kSlider');
  var kValue = document.getElementById('kValue');
  var contextToggle = document.getElementById('contextToggle');
  var skipSlider = document.getElementById('skipSlider');
  var skipValue = document.getElementById('skipValue');
  var percentSkippedEl = document.getElementById('percentSkipped');
  var timeSavedEl = document.getElementById('timeSaved');
  var peakCountEl = document.getElementById('peakCount');
  var statusLine = document.getElementById('statusLine');
  var coverageFill = document.getElementById('coverageFill');
  var gentleToggle = document.getElementById('gentleToggle');
  var perVideoBtn = document.getElementById('perVideoBtn');
  var perVideoOff = false;

  var PRESETS = {
    story: { k: 0.2, contextEnabled: true, maxSkipSec: 25 },
    balanced: { k: 0.5, contextEnabled: true, maxSkipSec: 45 },
    strict: { k: 0.9, contextEnabled: false, maxSkipSec: 45 }
  };

  var debounceTimer = null;

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }
    return m + 'm ' + String(s).padStart(2, '0') + 's';
  }

  function setStatus(msg) {
    if (statusLine) statusLine.textContent = msg;
  }

  function renderStats(state) {
    if (!state) return;
    if (percentSkippedEl) {
      percentSkippedEl.textContent = (state.percentSkipped !== undefined)
        ? state.percentSkipped + '%' : '—';
    }
    if (timeSavedEl) {
      timeSavedEl.textContent = (state.timeSavedSec !== undefined)
        ? fmtTime(state.timeSavedSec) : '—';
    }
    if (peakCountEl) {
      peakCountEl.textContent = (state.peakCount !== undefined) ? String(state.peakCount) : '—';
    }
    if (coverageFill && state.percentSkipped !== undefined && state.duration) {
      var kept = Math.max(0, Math.min(100, 100 - Number(state.percentSkipped)));
      coverageFill.style.width = kept + '%';
    }
    if (!state.ready) {
      setStatus('Analyzing video…');
    } else if (state.perVideoOff) {
      setStatus('Skipping paused for this video. Overlay hidden, video plays fully.');
    } else if (!state.heatmapFound) {
      setStatus('No Most-Replayed heatmap on this video. Playing normally.');
    } else {
      var extra = state.transcriptFound ? 'Transcript snapping on.' : 'No captions — wider buffers.';
      var ctx = state.contextEnabled === false ? ' Strict mode.' : ' Context bites on.';
      setStatus('Tracking ' + state.peakCount + ' segment(s). ' + extra + ctx);
    }
  }

  function sendToActiveTab(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (!tabs || !tabs.length || !tabs[0].id) {
            resolve(null);
            return;
          }
          chrome.tabs.sendMessage(tabs[0].id, msg, function (resp) {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(resp || null);
          });
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function refreshState() {
    sendToActiveTab({ type: 'PEAKPLAY_GET_STATE' }).then(function (resp) {
      if (!resp) {
        setStatus('Open a YouTube watch page to see live stats.');
        if (percentSkippedEl) percentSkippedEl.textContent = '—';
        if (timeSavedEl) timeSavedEl.textContent = '—';
        if (peakCountEl) peakCountEl.textContent = '—';
        return;
      }
      if (typeof resp.enabled === 'boolean') enabledToggle.checked = resp.enabled;
      if (typeof resp.contextEnabled === 'boolean') contextToggle.checked = resp.contextEnabled;
      if (typeof resp.gentleSkips === 'boolean') gentleToggle.checked = resp.gentleSkips;
      if (Number.isFinite(Number(resp.maxSkipSec))) {
        skipSlider.value = String(resp.maxSkipSec);
        skipValue.textContent = Math.round(Number(resp.maxSkipSec)) + 's';
      }
      perVideoOff = resp.perVideoOff === true;
      perVideoBtn.textContent = perVideoOff ? 'Skip this video again' : "Don't skip this video";
      perVideoBtn.classList.toggle('armed', perVideoOff);
      renderStats(resp);
    });
  }

  function init() {
    // Load persisted settings first (fast paint).
    try {
      chrome.storage.local.get(
        { enabled: true, k: 0.5, contextEnabled: true, maxSkipSec: 45, gentleSkips: true },
        function (items) {
          enabledToggle.checked = items.enabled !== false;
          var k = Number(items.k);
          if (!Number.isFinite(k)) k = 0.5;
          kSlider.value = String(k);
          kValue.textContent = Number(k).toFixed(2);
          contextToggle.checked = items.contextEnabled !== false;
          var ms = Number(items.maxSkipSec);
          if (!Number.isFinite(ms)) ms = 45;
          skipSlider.value = String(ms);
          skipValue.textContent = Math.round(ms) + 's';
          gentleToggle.checked = items.gentleSkips !== false;
        }
      );
    } catch (e) { /* ignore */ }

    enabledToggle.addEventListener('change', function () {
      var on = enabledToggle.checked;
      try { chrome.storage.local.set({ enabled: on }); } catch (e) { /* ignore */ }
      sendToActiveTab({ type: 'PEAKPLAY_SET_ENABLED', enabled: on }).then(function () {
        refreshState();
      });
      setStatus(on ? 'PeakPlay enabled.' : 'PeakPlay disabled. Playing normally.');
    });

    kSlider.addEventListener('input', function () {
      var k = Number(kSlider.value);
      kValue.textContent = Number(k).toFixed(2);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        try { chrome.storage.local.set({ k: k }); } catch (e) { /* ignore */ }
        sendToActiveTab({ type: 'PEAKPLAY_SET_K', k: k }).then(function (resp) {
          if (resp) renderStats(resp);
          else refreshState();
        });
      }, 250);
    });

    var ctxTimer = null;
    function pushContext() {
      var on = contextToggle.checked;
      var ms = Number(skipSlider.value);
      skipValue.textContent = Math.round(ms) + 's';
      if (ctxTimer) clearTimeout(ctxTimer);
      ctxTimer = setTimeout(function () {
        try { chrome.storage.local.set({ contextEnabled: on, maxSkipSec: ms }); } catch (e) { /* ignore */ }
        sendToActiveTab({ type: 'PEAKPLAY_SET_CONTEXT', contextEnabled: on, maxSkipSec: ms }).then(function (resp) {
          if (resp) renderStats(resp);
          else refreshState();
        });
      }, 250);
    }
    contextToggle.addEventListener('change', pushContext);
    skipSlider.addEventListener('input', pushContext);

    gentleToggle.addEventListener('change', function () {
      var on = gentleToggle.checked;
      try { chrome.storage.local.set({ gentleSkips: on }); } catch (e) { /* ignore */ }
      sendToActiveTab({ type: 'PEAKPLAY_SET_GENTLE', gentleSkips: on }).then(function () {
        refreshState();
      });
    });

    perVideoBtn.addEventListener('click', function () {
      sendToActiveTab({ type: 'PEAKPLAY_SET_PER_VIDEO', off: !perVideoOff }).then(function (resp) {
        if (resp && typeof resp.perVideoOff === 'boolean') {
          perVideoOff = resp.perVideoOff;
          perVideoBtn.textContent = perVideoOff ? 'Skip this video again' : "Don't skip this video";
          perVideoBtn.classList.toggle('armed', perVideoOff);
        }
        refreshState();
      });
    });

    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = PRESETS[btn.getAttribute('data-preset')];
        if (!p) return;
        document.querySelectorAll('[data-preset]').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        kSlider.value = String(p.k);
        kValue.textContent = Number(p.k).toFixed(2);
        contextToggle.checked = p.contextEnabled;
        skipSlider.value = String(p.maxSkipSec);
        skipValue.textContent = p.maxSkipSec + 's';
        try {
          chrome.storage.local.set({ k: p.k, contextEnabled: p.contextEnabled, maxSkipSec: p.maxSkipSec });
        } catch (e) { /* ignore */ }
        sendToActiveTab({ type: 'PEAKPLAY_SET_K', k: p.k }).then(function () {
          sendToActiveTab({
            type: 'PEAKPLAY_SET_CONTEXT',
            contextEnabled: p.contextEnabled,
            maxSkipSec: p.maxSkipSec
          }).then(function (resp) {
            if (resp) renderStats(resp);
            else refreshState();
          });
        });
      });
    });

    refreshState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

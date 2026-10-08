/**
 * content.js — PeakPlay YouTube controller.
 * Depends on: detectPeaks (signal_processor.js), snapToSentenceBoundaries (transcript_snapper.js)
 * Runs in YouTube watch pages. Zero-latency client-side skipping.
 */
(function () {
  'use strict';

  var STATE = {
    enabled: true,
    k: 0.5,
    mergeGap: 3,
    contextEnabled: true,
    maxSkipSec: 45,
    contextKeepSec: 8,
    gentleSkips: true,
    perVideoOff: false,
    kTunedForVideo: null,
    peakRanges: [],
    videoDuration: 0,
    heatmapFound: false,
    transcriptFound: false,
    transcriptPunctuated: false,
    splitTranscript: null,
    videoId: null,
    rawHeatmap: [],
    rawTranscript: [],
    rawWords: null,
    trackLang: null,
    ready: false,
    lastError: null
  };

  var videoEl = null;
  var isSeeking = false;
  var badgeEl = null;
  var computeToken = 0;
  var observerSetup = false;

  // ---------- storage ----------
  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(
          { enabled: true, k: 0.5, contextEnabled: true, maxSkipSec: 45, contextKeepSec: 8, gentleSkips: true },
          function (items) {
            STATE.enabled = items.enabled !== false;
            var k = Number(items.k);
            STATE.k = Number.isFinite(k) ? Math.min(1.5, Math.max(0.1, k)) : 0.5;
            STATE.contextEnabled = items.contextEnabled !== false;
            var ms = Number(items.maxSkipSec);
            STATE.maxSkipSec = Number.isFinite(ms) ? Math.min(120, Math.max(15, ms)) : 45;
            var ck = Number(items.contextKeepSec);
            STATE.contextKeepSec = Number.isFinite(ck) ? Math.min(20, Math.max(3, ck)) : 8;
            STATE.gentleSkips = items.gentleSkips !== false;
            resolve();
          }
        );
      } catch (e) {
        resolve();
      }
    });
  }

  // ---------- player response ----------
  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        return window.ytInitialPlayerResponse;
      }
    } catch (e) { /* ignore */ }

    // Fallback: scan script tags for ytInitialPlayerResponse JSON.
    try {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var txt = scripts[i].textContent || '';
        if (txt.indexOf('ytInitialPlayerResponse') === -1) continue;
        var m = txt.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
        if (m && m[1]) {
          try { return JSON.parse(m[1]); } catch (e2) { /* continue */ }
        }
        // ytplayer.config variant
        var m2 = txt.match(/"playerResponse"\s*:\s*("\{.+?\}"|\{.+?\})/s);
        if (m2 && m2[1]) {
          try {
            var raw = m2[1];
            if (raw.charAt(0) === '"') raw = JSON.parse(raw);
            if (typeof raw === 'string') return JSON.parse(raw);
            return raw;
          } catch (e3) { /* continue */ }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function getVideoId() {
    try {
      var url = new URL(window.location.href);
      var v = url.searchParams.get('v');
      if (v) return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function getVideoDuration() {
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      return videoEl.duration;
    }
    try {
      var pr = getPlayerResponse();
      var len = pr && pr.videoDetails && pr.videoDetails.lengthSeconds;
      var n = Number(len);
      if (Number.isFinite(n) && n > 0) return n;
    } catch (e) { /* ignore */ }
    return 0;
  }

  // ---------- heatmap extraction ----------
  function deepCollectHeatMarkers(root) {
    var found = [];
    var seen = new Set();
    var stack = [root];
    var steps = 0;
    while (stack.length && steps < 20000) {
      steps += 1;
      var node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }
      // Direct heat marker
      if (node.heatMarkerRenderer && typeof node.heatMarkerRenderer === 'object') {
        found.push(node.heatMarkerRenderer);
      } else if (
        node.timeRangeStartMillis !== undefined &&
        (node.heatMarkerIntensityScoreNormalized !== undefined ||
          node.intensityScoreNormalized !== undefined)
      ) {
        found.push(node);
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var val = node[key];
        if (val && typeof val === 'object') stack.push(val);
      }
    }
    return found;
  }

  function findHeatKeyPaths(root, maxHits) {
    var hits = [];
    var seen = new Set();
    var stack = [{ node: root, path: '$' }];
    var steps = 0;
    while (stack.length && steps < 30000 && hits.length < (maxHits || 20)) {
      steps += 1;
      var item = stack.pop();
      var node = item.node;
      var path = item.path;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = node.length - 1; i >= 0; i--) {
          stack.push({ node: node[i], path: path + '[' + i + ']' });
        }
        continue;
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var low = key.toLowerCase();
        if (
          low.indexOf('heat') !== -1 || low.indexOf('marker') !== -1 ||
          low.indexOf('replay') !== -1 || low.indexOf('intensity') !== -1 ||
          low.indexOf('macromarker') !== -1
        ) {
          var v = node[key];
          var preview = Array.isArray(v)
            ? 'array[' + v.length + ']'
            : (v && typeof v === 'object' ? 'object' : String(v).slice(0, 80));
          hits.push(path + '.' + key + ' = ' + preview);
          if (hits.length >= (maxHits || 20)) break;
        }
        var child = node[key];
        if (child && typeof child === 'object') {
          stack.push({ node: child, path: path + '.' + key });
        }
      }
    }
    return hits;
  }

  function extractHeatmap(playerResponse) {
    if (!playerResponse) return [];
    var markers = deepCollectHeatMarkers(playerResponse);
    if (!markers.length) return [];

    var pts = [];
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var startMillis = m.timeRangeStartMillis !== undefined ? m.timeRangeStartMillis : m.startMillis;
      var intensity = m.heatMarkerIntensityScoreNormalized !== undefined
        ? m.heatMarkerIntensityScoreNormalized
        : m.intensityScoreNormalized;
      var dur = m.markerDurationMillis !== undefined ? m.markerDurationMillis : m.durationMillis;
      if (startMillis === undefined || intensity === undefined) continue;
      var entry = {
        startMillis: Number(startMillis),
        intensityScoreNormalized: Number(intensity)
      };
      if (dur !== undefined) entry.markerDurationMillis = Number(dur);
      if (!Number.isFinite(entry.startMillis) || !Number.isFinite(entry.intensityScoreNormalized)) continue;
      pts.push(entry);
    }
    // De-duplicate by startMillis, keep max intensity.
    var byStart = {};
    pts.forEach(function (p) {
      var k = String(p.startMillis);
      if (!byStart[k] || byStart[k].intensityScoreNormalized < p.intensityScoreNormalized) {
        byStart[k] = p;
      }
    });
    var deduped = Object.keys(byStart).map(function (k) { return byStart[k]; });
    deduped.sort(function (a, b) { return a.startMillis - b.startMillis; });
    return deduped;
  }

  // Ordered caption tracks: manual English > auto English > manual other > auto other.
  // The fetcher tries them in order instead of giving up after the first.
  function rankTrack(t) {
    var lang = (t.languageCode || '').toLowerCase();
    var score = (lang.indexOf('en') === 0) ? 0 : 2;
    if (t.kind === 'asr') score += 1;
    return score;
  }

  function extractCaptionTracks(playerResponse) {
    try {
      var list = playerResponse
        && playerResponse.captions
        && playerResponse.captions.playerCaptionsTracklistRenderer
        && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!Array.isArray(list) || !list.length) return [];
      return list
        .filter(function (t) { return t && t.baseUrl; })
        .map(function (t) {
          return { url: t.baseUrl, lang: t.languageCode || '?', kind: t.kind || 'manual' };
        })
        .sort(function (a, b) {
          return rankTrack(a) - rankTrack(b) ||
            String(a.lang).localeCompare(String(b.lang));
        });
    } catch (e) {
      return [];
    }
  }

  function extractCaptionTrackUrl(playerResponse) {
    var tracks = extractCaptionTracks(playerResponse);
    return tracks.length ? tracks[0].url : null;
  }

  // ---------- transcript fetching ----------
  function decodeHtml(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '');
  }

  function parseJson3(json) {
    var segs = [];
    var events = (json && json.events) || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev == null || ev.tStartMs === undefined) continue;
      var evStart = ev.tStartMs / 1000;
      var evDur = (ev.dDurationMs || 0) / 1000;
      var parts = ev.segs || [];
      // Word-level timing when YouTube provides tOffsetMs per seg.
      var hasWordTiming = parts.some(function (p) {
        return p && p.tOffsetMs !== undefined && p.utf8;
      });
      if (hasWordTiming) {
        for (var w = 0; w < parts.length; w++) {
          var pw = parts[w];
          var wt = (pw.utf8 || '').replace(/\n/g, ' ').trim();
          if (!wt) continue;
          var wStart = evStart + (Number(pw.tOffsetMs) || 0) / 1000;
          var wDur = pw.dDurationMs !== undefined
            ? Number(pw.dDurationMs) / 1000
            : 0.4;
          if (!Number.isFinite(wDur) || wDur <= 0) wDur = 0.4;
          segs.push({ start: wStart, duration: wDur, text: wt, word: true });
        }
        continue;
      }
      var text = parts.map(function (p) { return p.utf8 || ''; }).join('');
      text = text.replace(/\n/g, ' ').trim();
      if (!text) continue;
      segs.push({
        start: evStart,
        duration: evDur,
        text: text
      });
    }
    // Merge stray single-word fragments back into lines for snapping,
    // but keep the raw word timestamps on the side for precise landings.
    var merged = [];
    var words = [];
    for (var m = 0; m < segs.length; m++) {
      var s = segs[m];
      if (s.word) {
        words.push({ start: s.start, text: s.text });
        if (merged.length) {
          var prev = merged[merged.length - 1];
          if (prev.word && s.start - (prev.start + prev.duration) < 0.25 && (prev.text + ' ' + s.text).length < 90) {
            prev.text = (prev.text + ' ' + s.text).trim();
            prev.duration = (s.start + s.duration) - prev.start;
            continue;
          }
        }
      }
      merged.push({ start: s.start, duration: s.duration, text: s.text });
    }
    if (words.length >= 4) merged.words = words;
    return merged;
  }

  function parseTimedtextXml(xmlText) {
    var segs = [];
    try {
      var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
      // Classic timedtext uses <text start dur>; srv3 uses <p t d> (millis).
      var nodes = doc.getElementsByTagName('text');
      var isSrv3 = false;
      if (!nodes.length) {
        nodes = doc.getElementsByTagName('p');
        isSrv3 = nodes.length > 0;
      }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var start, dur;
        if (isSrv3) {
          start = Number(n.getAttribute('t')) / 1000;
          dur = Number(n.getAttribute('d')) / 1000;
        } else {
          start = Number(n.getAttribute('start'));
          dur = Number(n.getAttribute('dur') || n.getAttribute('durSec') || 0);
        }
        var text = decodeHtml(stripTags(n.textContent || '')).replace(/\s+/g, ' ').trim();
        if (!Number.isFinite(start) || !text) continue;
        if (!Number.isFinite(dur) || dur <= 0) dur = 2.0;
        segs.push({ start: start, duration: dur, text: text });
      }
    } catch (e) { /* ignore */ }
    return segs;
  }

  function parseVTT(vttText) {
    var segs = [];
    function ts(s) {
      var m = String(s || '').match(/(?:(\d+):)?(\d\d):(\d\d)\.(\d{3})/);
      if (!m) return NaN;
      return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    }
    try {
      var blocks = String(vttText).split(/\r?\n\r?\n/);
      for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split(/\r?\n/);
        var arrow = -1;
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('-->') !== -1) { arrow = j; break; }
        }
        if (arrow < 0) continue;
        var parts = lines[arrow].split('-->');
        var start = ts(parts[0]);
        var end = ts(parts[1]);
        var text = decodeHtml(stripTags(lines.slice(arrow + 1).join(' '))).replace(/\s+/g, ' ').trim();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
        segs.push({ start: start, duration: end - start, text: text });
      }
    } catch (e) { /* ignore */ }
    return segs;
  }

  // Tries every track in preference order, and per track: URL as-is first
  // (keeps any signature intact), then json3 / vtt / srv3 overrides.
  // First non-empty parse wins — never gives up after one empty 200.
  function fetchTranscript(tracksOrUrl) {
    var tracks = Array.isArray(tracksOrUrl)
      ? tracksOrUrl.slice()
      : (tracksOrUrl ? [{ url: tracksOrUrl, lang: '?', kind: '?' }] : []);
    tracks = tracks.filter(function (t) { return t && t.url; });
    if (!tracks.length) return Promise.resolve([]);

    var FORMATS = [null, 'json3', 'vtt', 'srv3'];

    function parseBody(text, fmtHint, contentType) {
      var t = (text || '').trim();
      if (!t) return [];
      if (fmtHint === 'json3' || t.charAt(0) === '{' || (contentType || '').indexOf('json') !== -1) {
        if (t.charAt(0) === '{') {
          try { return parseJson3(JSON.parse(t)); } catch (e) { /* fall through */ }
        } else {
          return [];
        }
      }
      if (/WEBVTT/i.test(t.slice(0, 20))) return parseVTT(t);
      return parseTimedtextXml(t);
    }

    function tryFormat(base, fi) {
      if (fi >= FORMATS.length) return Promise.resolve([]);
      var url = base;
      try {
        var u = new URL(base, window.location.origin);
        if (FORMATS[fi]) u.searchParams.set('fmt', FORMATS[fi]);
        url = u.toString();
      } catch (e) { /* use raw */ }
      return fetch(url, { credentials: 'include' }).then(function (res) {
        if (!res.ok) throw new Error('caption fetch ' + res.status);
        var ct = res.headers.get('content-type') || '';
        if (FORMATS[fi] === 'json3' || ct.indexOf('json') !== -1) {
          return res.text().then(function (body) {
            var segs = parseBody(body, FORMATS[fi], ct);
            if (segs.length) return segs;
            throw new Error('empty parse');
          });
        }
        return res.text().then(function (body) {
          var segs = parseBody(body, FORMATS[fi], ct);
          if (segs.length) return segs;
          throw new Error('empty parse');
        });
      }).catch(function () {
        return tryFormat(base, fi + 1);
      });
    }

    function tryTrack(i) {
      if (i >= tracks.length) return Promise.resolve([]);
      return tryFormat(tracks[i].url, 0).then(function (segs) {
        if (segs && segs.length) {
          segs.trackLang = tracks[i].lang;
          return segs;
        }
        return tryTrack(i + 1);
      });
    }

    return tryTrack(0);
  }

  // ---------- peak computation ----------
  function recomputeFromCache() {
    STATE.videoDuration = getVideoDuration();
    if (!STATE.rawHeatmap.length) {
      STATE.peakRanges = [];
      STATE.ready = true;
      updateBadge();
      return;
    }
    var detect = (typeof detectPeaks === 'function')
      ? detectPeaks
      : (window.detectPeaks || null);
    var snap = (typeof snapToSentenceBoundaries === 'function')
      ? snapToSentenceBoundaries
      : (window.snapToSentenceBoundaries || null);
    var addCtx = (typeof addContextKeeps === 'function')
      ? addContextKeeps
      : (window.addContextKeeps || null);
    var finalRanges = buildFinal(STATE.k, detect, snap, addCtx);
    // Auto-tune once per video when k is still the default: keep coverage
    // sane (25–90%) so first-run experience isn't "skips everything/nothing".
    if (STATE.k === 0.5 && STATE.videoId && STATE.kTunedForVideo !== STATE.videoId && STATE.videoDuration > 90) {
      var cov = coverageOf(finalRanges, STATE.videoDuration);
      var tuned = null;
      var cands = cov < 0.25 ? [0.4, 0.3, 0.2, 0.15] : (cov > 0.9 ? [0.6, 0.8, 1.0, 1.2] : []);
      for (var ti = 0; ti < cands.length; ti++) {
        var trial = buildFinal(cands[ti], detect, snap, addCtx);
        var tcov = coverageOf(trial, STATE.videoDuration);
        if (tcov >= 0.25 && tcov <= 0.9) {
          tuned = cands[ti];
          finalRanges = trial;
          break;
        }
      }
      if (tuned === null && cands.length) {
        tuned = cands[cands.length - 1];
        finalRanges = buildFinal(tuned, detect, snap, addCtx);
      }
      STATE.kTunedForVideo = STATE.videoId;
      if (tuned !== null) {
        STATE.k = tuned;
        try { chrome.storage.local.set({ k: tuned }); } catch (e) { /* ignore */ }
        dbg('auto-tuned k', { k: tuned, coverage: Math.round(coverageOf(finalRanges, STATE.videoDuration) * 100) + '%' });
      }
    }
    STATE.peakRanges = finalRanges;
    STATE.ready = true;
    updateBadge();
    dbg('peaks ready', {
      heatmap: STATE.rawHeatmap.length,
      peaks: STATE.peakRanges,
      transcript: (STATE.rawTranscript || []).length,
      duration: STATE.videoDuration
    });
  }

  function coverageOf(ranges, dur) {
    if (!(dur > 0) || !ranges.length) return 0;
    var kept = 0;
    for (var ci = 0; ci < ranges.length; ci++) {
      kept += Math.max(0, ranges[ci][1] - ranges[ci][0]);
    }
    return Math.min(1, kept / dur);
  }

  function buildFinal(kVal, detectFn, snapFn, addCtxFn) {
    var rawPeaks = [];
    try {
      rawPeaks = detectFn ? detectFn(STATE.rawHeatmap, kVal, STATE.mergeGap) : [];
    } catch (e) {
      rawPeaks = [];
    }
    // Clamp to duration.
    if (STATE.videoDuration > 0) {
      rawPeaks = rawPeaks
        .map(function (r) {
          return [Math.max(0, r[0]), Math.min(STATE.videoDuration, r[1])];
        })
        .filter(function (r) { return r[1] > r[0]; });
    }
    var withContext = rawPeaks;
    try {
      if (STATE.contextEnabled && addCtxFn && STATE.videoDuration > 0) {
        withContext = addCtxFn(rawPeaks, STATE.videoDuration, STATE.maxSkipSec, STATE.contextKeepSec);
      }
    } catch (e) {
      withContext = rawPeaks;
    }
    var out = withContext;
    try {
      if (snapFn) {
        out = snapFn(withContext, STATE.rawTranscript || [], {
          pauseThreshold: 0.5,
          preRoll: 0.8,
          postRoll: 1.1,
          maxWalk: 20,
          fullStopOnly: true
        });
      }
    } catch (e) {
      out = withContext;
    }
    return out;
  }

  // ---------- page-context bridge (MAIN world) ----------
  // Content scripts run in an isolated world and cannot read
  // window.ytInitialPlayerResponse directly. inject.js runs in page
  // context and returns the extracted heatmap via CustomEvent.
  var injectReady = false;
  var injectLoadPromise = null;

  function ensureInject() {
    if (injectLoadPromise) return injectLoadPromise;
    injectLoadPromise = new Promise(function (resolve) {
      try {
        var existing = document.getElementById('peakplay-inject-loaded');
        if (existing || injectReady) {
          injectReady = true;
          resolve(true);
          return;
        }
        var s = document.createElement('script');
        s.id = 'peakplay-inject';
        s.src = chrome.runtime.getURL('content/inject.js');
        s.onload = function () {
          injectReady = true;
          try {
            var marker = document.createElement('span');
            marker.id = 'peakplay-inject-loaded';
            marker.style.display = 'none';
            (document.head || document.documentElement).appendChild(marker);
          } catch (e) { /* ignore */ }
          try { s.remove(); } catch (e2) { /* ignore */ }
          resolve(true);
        };
        s.onerror = function () {
          dbg('inject.js failed to load (CSP/blocked?)', s.src);
          resolve(false);
        };
        (document.head || document.documentElement).appendChild(s);
        // Safety: resolve anyway after 3s so compute never hangs.
        setTimeout(function () { resolve(injectReady); }, 3000);
      } catch (e) {
        resolve(false);
      }
    });
    return injectLoadPromise;
  }

  // Ultimate fallback: parse the rendered Most-Replayed graph so
  // skipping works even when playerResponse keys are renamed.
  // Handles: SVG path (multiple containers, longest d wins) + bar-divs.
  function extractHeatmapFromDOM() {
    try {
      attachToVideo();
      var dur = (videoEl && videoEl.duration) || getVideoDuration() || 0;
      if (!(dur > 0)) dur = 600;

      var containers = document.querySelectorAll('.ytp-heat-map-container');
      var bestD = '';
      for (var ci = 0; ci < containers.length; ci++) {
        var paths = containers[ci].querySelectorAll('path');
        for (var pi = 0; pi < paths.length; pi++) {
          var dd = paths[pi].getAttribute('d') || '';
          if (dd.length > bestD.length) bestD = dd;
        }
      }
      // Also try any progress-bar svg if container query missed.
      if (!bestD) {
        var allPaths = document.querySelectorAll('.ytp-progress-bar-container svg path, ytd-player svg path');
        for (var ai = 0; ai < allPaths.length; ai++) {
          var d2 = allPaths[ai].getAttribute('d') || '';
          if (d2.length > bestD.length && (d2.match(/-?\d+(\.\d+)?/g) || []).length >= 16) bestD = d2;
        }
      }
      if (bestD) {
        var parsed = heatPathToMarkers(bestD, dur);
        if (parsed.length >= 8) return parsed;
      }

      // Bar-div format: children with height % or scaleY.
      for (var cj = 0; cj < containers.length; cj++) {
        var bars = containers[cj].children;
        if (bars && bars.length >= 8) {
          var heats = [];
          for (var bi = 0; bi < bars.length; bi++) {
            var h = 0;
            try {
              var st = window.getComputedStyle(bars[bi]);
              h = parseFloat(st.height) || parseFloat(bars[bi].style.height) || 0;
              var tr = st.transform || '';
              var m = tr.match(/matrix\([^,]+,[^,]+,[^,]+,([^,]+),/);
              if (m) h = h * Math.abs(Number(m[1]) || 1);
            } catch (e) { /* ignore */ }
            heats.push(h);
          }
          var mx = Math.max.apply(null, heats);
          if (mx > 0) {
            var out = [];
            for (var bj = 0; bj < heats.length; bj++) {
              out.push({
                startMillis: Math.round((bj / heats.length) * dur * 1000),
                intensityScoreNormalized: Math.max(0, Math.min(1, heats[bj] / mx)),
                markerDurationMillis: Math.round((dur * 1000) / heats.length)
              });
            }
            return out;
          }
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  function heatPathToMarkers(d, dur) {
    try {
      var nums = d.match(/-?\d+(\.\d+)?/g);
      if (!nums || nums.length < 16) return [];
      var vals = nums.map(Number);
      var ys = [];
      for (var i = 1; i < vals.length; i += 2) ys.push(vals[i]);
      if (ys.length < 8) return [];
      var minY = Math.min.apply(null, ys);
      var maxY = Math.max.apply(null, ys);
      var span = maxY - minY;
      if (!(span > 0)) return [];
      var n = ys.length;
      var out = [];
      for (var j = 0; j < n; j++) {
        out.push({
          startMillis: Math.round((j / n) * dur * 1000),
          intensityScoreNormalized: Math.max(0, Math.min(1, (maxY - ys[j]) / span)),
          markerDurationMillis: Math.round((dur * 1000) / n)
        });
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function getPageDataViaInject(timeoutMs) {
    return ensureInject().then(function () {
      return new Promise(function (resolve) {
      var done = false;
      var reqId = 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      function onResp(ev) {
        try {
          var d = ev && ev.detail;
          if (!d || d.reqId !== reqId) return;
          if (done) return;
          done = true;
          document.removeEventListener('PEAKPLAY_RESPONSE', onResp);
          resolve(d);
        } catch (e) { /* ignore */ }
      }
      document.addEventListener('PEAKPLAY_RESPONSE', onResp);
      try {
        document.dispatchEvent(new CustomEvent('PEAKPLAY_REQUEST', { detail: { reqId: reqId } }));
      } catch (e) {
        if (!done) {
          done = true;
          document.removeEventListener('PEAKPLAY_RESPONSE', onResp);
          resolve(null);
        }
        return;
      }
      setTimeout(function () {
        if (done) return;
        done = true;
        try { document.removeEventListener('PEAKPLAY_RESPONSE', onResp); } catch (e) { /* ignore */ }
        resolve(null);
      }, timeoutMs || 2500);
      });
    });
  }

  function computeForCurrentVideo() {
    var token = ++computeToken;
    STATE.videoId = getVideoId();
    STATE.ready = false;
    STATE.lastError = null;
    STATE.videoDuration = getVideoDuration();

    getPageDataViaInject(2500).then(function (pageData) {
      if (token !== computeToken) return;
      var heatmap = [];
      var tracks = [];
      var pageDuration = 0;

      if (pageData && pageData.ok && Array.isArray(pageData.heatmap) && pageData.heatmap.length) {
        heatmap = pageData.heatmap;
        if (Array.isArray(pageData.captionTracks) && pageData.captionTracks.length) {
          tracks = pageData.captionTracks;
        } else if (pageData.captionUrl) {
          tracks = [{ url: pageData.captionUrl, lang: '?', kind: '?' }];
        }
        pageDuration = Number(pageData.duration) || 0;
        dbg('page-context heatmap', { markers: heatmap.length, duration: pageDuration });
      } else {
        // Fallback 1: isolated-world DOM parsing.
        var pr = getPlayerResponse();
        heatmap = extractHeatmap(pr);
        tracks = extractCaptionTracks(pr);
        var domHeat = [];
        var keyPaths = [];
        if (!heatmap.length) {
          // Fallback 2: rendered SVG graph (works even without playerResponse).
          attachToVideo();
          domHeat = extractHeatmapFromDOM();
          if (domHeat.length) heatmap = domHeat;
          // Diagnostic: log where heat-like keys live in this PR shape.
          try {
            keyPaths = pr ? findHeatKeyPaths(pr, 20) : ['no-PR'];
            var heatContainer = document.querySelector('.ytp-heat-map-container');
            dbg('heatmap diagnostics', {
              prKeys: pr ? Object.keys(pr).slice(0, 20) : [],
              heatKeyPaths: keyPaths,
              heatContainerHTML: heatContainer
                ? (heatContainer.outerHTML || '').slice(0, 500)
                : 'no .ytp-heat-map-container',
              svgCount: document.querySelectorAll('ytd-player svg path').length
            });
          } catch (e) { /* ignore */ }
        }
        dbg('fallback heatmap', {
          markers: heatmap.length,
          domMarkers: domHeat.length,
          reason: pageData ? (pageData.reason || 'empty') : 'no-inject-response',
          hasPR: !!pr,
          pageSources: pageData && pageData.sources,
          pageKeyPaths: pageData && pageData.keyPaths
        });
      }

      if (pageDuration > 0 && !(STATE.videoDuration > 0)) {
        STATE.videoDuration = pageDuration;
      }

      continueWithHeatmap(token, heatmap, tracks);
    });

    // Safety net: if inject hangs entirely, fall back via timeout path above (resolves null).
  }

  function continueWithHeatmap(token, heatmap, tracks) {
    STATE.rawHeatmap = Array.isArray(heatmap) ? heatmap : [];
    STATE.heatmapFound = STATE.rawHeatmap.length > 0;

    function finish(transcript) {
      if (token !== computeToken) return; // stale navigation
      STATE.rawTranscript = transcript || [];
      STATE.transcriptFound = STATE.rawTranscript.length > 0;
      STATE.rawWords = (transcript && transcript.words && transcript.words.length >= 4)
        ? transcript.words
        : null;
      STATE.trackLang = (transcript && transcript.trackLang) || null;
      STATE.transcriptPunctuated = isTranscriptPunctuated(STATE.rawTranscript);
      try {
        var norm = (window.__PeakPlaySnapper && window.__PeakPlaySnapper.normalizeSegments)
          ? window.__PeakPlaySnapper.normalizeSegments(STATE.rawTranscript)
          : null;
        STATE.splitTranscript = norm && norm.length ? norm : null;
      } catch (e) {
        STATE.splitTranscript = null;
      }
      STATE.videoDuration = getVideoDuration();
      dbg('transcript ready', {
        segments: STATE.rawTranscript.length,
        words: STATE.rawWords ? STATE.rawWords.length : 0,
        trackLang: STATE.trackLang,
        punctuated: STATE.transcriptPunctuated,
        hasTracks: !!(tracks && tracks.length),
        sample: (STATE.rawTranscript[0] && STATE.rawTranscript[0].text || '').slice(0, 80)
      });
      recomputeFromCache();
    }

  function isTranscriptPunctuated(tr) {
    try {
      if (!tr || tr.length < 4) return false;
      var stops = 0;
      for (var i = 0; i < tr.length; i++) {
        if (/[.!?\u2026\u0964\u0965"'\u201d)\]]\s*$/.test(String(tr[i].text || ''))) stops += 1;
      }
      return stops / tr.length >= 0.05;
    } catch (e) {
      return false;
    }
  }

    if (!STATE.heatmapFound) {
      // Nothing to skip; still try transcript for future, but mark ready.
      STATE.peakRanges = [];
      STATE.ready = true;
      STATE.lastError = 'no-heatmap';
      updateBadge();
      // Opportunistically fetch transcript anyway (cheap, async).
      if (tracks && tracks.length) {
        fetchTranscript(tracks).then(function (t) {
          if (token !== computeToken) return;
          STATE.rawTranscript = t || [];
          STATE.transcriptFound = STATE.rawTranscript.length > 0;
        });
      }
      return;
    }

    if (tracks && tracks.length) {
      fetchTranscript(tracks).then(finish, function () { finish([]); });
      // Safety timeout: don't block skipping on slow captions.
      setTimeout(function () {
        if (token !== computeToken || STATE.ready) return;
        if (!STATE.rawTranscript.length && STATE.peakRanges.length === 0) {
          STATE.rawTranscript = [];
          STATE.rawWords = null;
          dbg('transcript timeout — computing with heatmap only');
          recomputeFromCache();
        }
      }, 3500);
    } else {
      dbg('no caption track — heatmap only, wider buffers');
      finish([]);
    }
  }

  // ---------- skipping (smooth + user-respecting) ----------
  var manualCooldownUntil = 0;
  var checkerTimer = null;
  var deferredTimer = null;
  var deferredTarget = null;

  function findNextPeak(current) {
    var ranges = STATE.peakRanges;
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i][1] < current - 0.05) continue;
      if (current >= ranges[i][0] - 0.12 && current <= ranges[i][1] + 0.12) {
        return null; // inside a peak: play
      }
      if (ranges[i][0] > current + 0.15) return ranges[i];
    }
    return null;
  }

  function smoothJumpTo(target) {
    if (!videoEl) return;
    try {
      isSeeking = true;
      var from = videoEl.currentTime;
      var jump = Math.abs(target - from);
      // Quick volume fade masks the cut so it feels like an edit, not a glitch.
      var faded = false;
      try {
        if (jump > 1.5 && !videoEl.muted && videoEl.volume > 0.05) {
          faded = true;
          var v0 = videoEl.volume;
          videoEl.volume = Math.max(0, v0 - 0.35);
          setTimeout(function () {
            try { if (videoEl) videoEl.volume = v0; } catch (e) { /* ignore */ }
          }, 350);
        }
      } catch (e) { /* ignore */ }
      if (jump > 2 && typeof videoEl.fastSeek === 'function') {
        try { videoEl.fastSeek(target); }
        catch (e) { videoEl.currentTime = target; }
      } else {
        videoEl.currentTime = target;
      }
      dbg('skip', { from: Math.round(from * 10) / 10, to: target, faded: faded });
      showSkipToast(from, target);
    } catch (e) {
      isSeeking = false;
    }
  }

  // Transient "Skipped 1:13 → 4:02" chip inside the player so jumps are visible.
  function showSkipToast(fromSec, toSec) {
    try {
      var player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (!player) return;
      var toast = document.getElementById('peakplay-toast');
      if (!toast || !toast.isConnected) {
        toast = document.createElement('div');
        toast.id = 'peakplay-toast';
        toast.setAttribute('data-peakplay', 'true');
        toast.style.cssText = [
          'position:absolute', 'left:12px', 'bottom:56px', 'z-index:1000',
          'font-family:Roboto,Arial,sans-serif', 'font-size:12px', 'font-weight:600',
          'background:rgba(20,20,22,.92)', 'color:#7be2a8',
          'border:1px solid rgba(15,157,88,.55)', 'border-radius:16px',
          'padding:6px 12px', 'pointer-events:none', 'opacity:0',
          'transition:opacity .3s'
        ].join(';');
        try {
          var pos = window.getComputedStyle(player).position;
          if (pos === 'static') player.style.position = 'relative';
        } catch (e) { /* ignore */ }
        player.appendChild(toast);
      }
      toast.textContent = 'Skipped ' + fmtClock(fromSec) + ' → ' + fmtClock(toSec);
      toast.style.opacity = '0.95';
      if (toast._hideTimer) { try { clearTimeout(toast._hideTimer); } catch (e) { /* ignore */ } }
      toast._hideTimer = setTimeout(function () {
        try { toast.style.opacity = '0'; } catch (e) { /* ignore */ }
      }, 2200);
    } catch (e) { /* ignore */ }
  }

  function maybeSkip(reason) {
    if (!STATE.enabled || STATE.perVideoOff || !STATE.ready || !STATE.peakRanges.length) return;
    if (isSeeking || !videoEl) return;
    try { if (videoEl.seeking) return; } catch (e) { /* ignore */ }
    if (Date.now() < manualCooldownUntil) return;
    // Never fight ads / live edges.
    try {
      if (document.querySelector('.ad-showing')) return;
      if (!Number.isFinite(videoEl.duration) || videoEl.duration === Infinity) return;
    } catch (e) { /* ignore */ }
    var current = videoEl.currentTime;
    if (!Number.isFinite(current)) return;
    var next = findNextPeak(current);
    if (!next) { cancelDeferredSkip(); return; }
    var jump = next[0] - current;
    if (jump < 0.25) return;
    // Don't yank the outro: if past last peak, let credits play.
    var last = STATE.peakRanges[STATE.peakRanges.length - 1];
    if (current > last[1]) return;
    // Sentence-aware defer: if someone is mid-sentence, finish it first
    // (up to ~6s for a full stop), then jump. This is what stops "cut mid-word" skips.
    var pauseAt = findPauseForSkip(current, next[0]);
    var landing = adjustLandingForSentence(next[0] + 0.05, next[1]);
    if (pauseAt !== null && pauseAt > current + 0.15) {
      scheduleDeferredSkip(pauseAt, landing);
      return;
    }
    if (STATE.gentleSkips && speechSegmentAt(current)) {
      // Gentle mode: speaking with no full stop in sight — wait for the next
      // tick instead of cutting mid-sentence. The 700ms checker retries.
      cancelDeferredSkip();
      return;
    }
    cancelDeferredSkip();
    smoothJumpTo(landing);
  }

  function speechSegmentAt(t) {
    try {
      var tr = STATE.rawTranscript || [];
      for (var i = 0; i < tr.length; i++) {
        var s = Number(tr[i].start);
        var e = s + Number(tr[i].duration || 0);
        if (t >= s - 0.15 && t <= e + 0.1) return { seg: tr[i], idx: i, end: e };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function findPauseForSkip(current, destStart) {
    try {
      if (!STATE.transcriptFound || !(STATE.rawTranscript || []).length) return null;
      var hit = speechSegmentAt(current);
      if (!hit) return null; // in silence already: jump now
      var tr = STATE.rawTranscript;
      // Full stops can be sentences away — allow a longer wait than pauses.
      var maxWait = Math.min(6, Math.max(0, destStart - current - 0.2));
      if (maxWait < 0.3) return null;
      var strict = !!STATE.transcriptPunctuated;
      // Scan forward for the first full stop within maxWait.
      for (var i = hit.idx; i < tr.length; i++) {
        var s = Number(tr[i].start);
        var e = s + Number(tr[i].duration || 0);
        if (s - current > maxWait + 0.3) break;
        var txt = String(tr[i].text || '');
        var isEnd = /[.!?\u2026\u0964\u0965"'\u201d)\]]\s*$/.test(txt);
        var gapNext = (i + 1 < tr.length) ? Number(tr[i + 1].start) - e : 1;
        // Punctuated captions: ONLY full stops (or transcript end) release the skip.
        // Unpunctuated auto-captions: fall back to speech pauses.
        var releases = strict ? (isEnd || i === tr.length - 1) : (isEnd || gapNext >= 0.3);
        if (releases) {
          var pauseAt = Math.min(e + 0.12, destStart - 0.05);
          if (pauseAt > current + 0.15 && pauseAt < destStart) return pauseAt;
          return null;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function scheduleDeferredSkip(fireAt, dest) {
    try {
      if (!videoEl) return;
      if (deferredTimer && deferredTarget === dest) return; // already waiting
      cancelDeferredSkip();
      deferredTarget = dest;
      var delayMs = Math.max(80, Math.min(6200, (fireAt - videoEl.currentTime) * 1000));
      deferredTimer = setTimeout(function () {
        deferredTimer = null;
        deferredTarget = null;
        try { maybeSkip('deferred'); } catch (e) { /* ignore */ }
      }, delayMs);
    } catch (e) { /* ignore */ }
  }

  function cancelDeferredSkip() {
    try {
      if (deferredTimer) clearTimeout(deferredTimer);
    } catch (e) { /* ignore */ }
    deferredTimer = null;
    deferredTarget = null;
  }

  // Guarantee playback resumes at a sentence start (right after a full
  // stop). If the destination falls mid-sentence, back up to that
  // sentence's start so nothing begins mid-word. Silence landings pass through.
  function adjustLandingForSentence(dest, peakEnd) {
    try {
      var tr = STATE.splitTranscript || STATE.rawTranscript || [];
      if (!tr.length) return dest;
      var idx = -1;
      for (var i = 0; i < tr.length; i++) {
        var s = Number(tr[i].start);
        var e = (tr[i].end !== undefined) ? Number(tr[i].end) : s + Number(tr[i].duration || 0);
        if (dest >= s - 0.05 && dest <= e + 0.05) { idx = i; break; }
        if (s > dest) break;
      }
      if (idx < 0) return dest; // landing in silence: ideal, keep it
      var segS = Number(tr[idx].start);
      var into = dest - segS;
      var thresh = STATE.transcriptPunctuated ? 0.5 : 0.8;
      if (into <= thresh) return dest; // already at a sentence start
      var backed = Math.max(0, segS - 0.05);
      // Never back up past the peak's own start region or before zero.
      if (peakEnd !== undefined && backed > peakEnd - 0.8) return dest;
      // Word timestamps available: pin onto the exact word start so the
      // landing never sits inside a spoken word.
      try {
        var words = STATE.rawWords || [];
        if (words.length) {
          var best = -1;
          for (var wi = 0; wi < words.length; wi++) {
            var ws = Number(words[wi].start);
            if (!Number.isFinite(ws)) continue;
            if (ws > backed + 0.05) break;
            if (ws >= backed - 1.0) best = ws;
          }
          if (best >= 0) backed = Math.max(0, best);
        }
      } catch (e) { /* ignore */ }
      return backed;
    } catch (e) {
      return dest;
    }
  }

  function onTimeUpdate() {
    maybeSkip('timeupdate');
  }

  function onPlay() {
    // Landing in a gap then pressing play should jump immediately.
    setTimeout(function () { maybeSkip('play'); }, 120);
  }

  function onSeeking() {
    // Manual scrub while NOT our programmatic seek → respect user for 5s.
    if (!isSeeking) {
      manualCooldownUntil = Date.now() + 5000;
      cancelDeferredSkip();
      dbg('manual seek — pausing auto-skip 5s');
    }
  }

  function onSeeked() {
    isSeeking = false;
  }

  function startChecker() {
    if (checkerTimer) return;
    // Backup for throttled timeupdate (background tabs, odd codecs).
    checkerTimer = setInterval(function () {
      try { maybeSkip('interval'); } catch (e) { /* ignore */ }
    }, 700);
  }

  function attachToVideo() {
    var v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v === videoEl && v) return;
    if (videoEl) {
      try {
        videoEl.removeEventListener('timeupdate', onTimeUpdate);
        videoEl.removeEventListener('seeked', onSeeked);
        videoEl.removeEventListener('seeking', onSeeking);
        videoEl.removeEventListener('play', onPlay);
      } catch (e) { /* ignore */ }
    }
    videoEl = v;
    if (videoEl) {
      videoEl.addEventListener('timeupdate', onTimeUpdate);
      videoEl.addEventListener('seeked', onSeeked);
      videoEl.addEventListener('seeking', onSeeking);
      videoEl.addEventListener('play', onPlay);
      STATE.videoDuration = getVideoDuration();
      startChecker();
    }
  }

  // ---------- timeline overlay (visible skip zones on player) ----------
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function renderTimelineOverlay() {
    try {
      try {
        if (document.querySelector('.ad-showing')) {
          var old = document.getElementById('peakplay-timeline');
          if (old) old.style.display = 'none';
          return;
        }
      } catch (e) { /* ignore */ }
      var bar = document.querySelector('.ytp-progress-bar-container');
      if (!bar) return;
      var overlay = document.getElementById('peakplay-timeline');
      var show = STATE.enabled && !STATE.perVideoOff && STATE.heatmapFound && STATE.peakRanges.length > 0;
      if (!show) {
        if (overlay) overlay.style.display = 'none';
        return;
      }
      if (!overlay || !overlay.isConnected || overlay.parentElement !== bar) {
        try { if (overlay && overlay.parentElement) overlay.remove(); } catch (e) { /* ignore */ }
        overlay = document.createElement('div');
        overlay.id = 'peakplay-timeline';
        overlay.setAttribute('data-peakplay', 'true');
        overlay.style.cssText = [
          'position:absolute', 'left:0', 'right:0', 'top:0', 'bottom:0',
          'pointer-events:none', 'z-index:31', 'overflow:hidden'
        ].join(';');
        // Ensure bar can host absolute children.
        try {
          var pos = window.getComputedStyle(bar).position;
          if (pos === 'static') bar.style.position = 'relative';
        } catch (e) { /* ignore */ }
        bar.appendChild(overlay);
      }
      overlay.style.display = 'block';
      overlay.innerHTML = '';
      var dur = STATE.videoDuration || getVideoDuration() || 0;
      if (!(dur > 0)) return;

      var ranges = STATE.peakRanges.slice().sort(function (a, b) { return a[0] - b[0]; });

      function addSeg(s, e, kind, label) {
        if (!(e > s)) return;
        var left = Math.max(0, Math.min(100, (s / dur) * 100));
        var width = Math.max(0.3, Math.min(100 - left, ((e - s) / dur) * 100));
        var seg = document.createElement('div');
        seg.title = label;
        if (kind === 'keep') {
          seg.style.cssText = [
            'position:absolute', 'top:50%', 'transform:translateY(-50%)',
            'height:5px', 'border-radius:3px',
            'left:' + left + '%', 'width:' + width + '%',
            'background:#0f9d58', 'opacity:0.95',
            'box-shadow:0 0 4px rgba(15,157,88,.8)'
          ].join(';');
        } else {
          seg.style.cssText = [
            'position:absolute', 'top:50%', 'transform:translateY(-50%)',
            'height:5px', 'border-radius:3px',
            'left:' + left + '%', 'width:' + width + '%',
            'background:repeating-linear-gradient(45deg,rgba(255,70,70,.65) 0 4px,rgba(120,20,20,.55) 4px 8px)',
            'opacity:0.75'
          ].join(';');
        }
        overlay.appendChild(seg);
        if (kind === 'keep') {
          var tick = document.createElement('div');
          tick.title = 'Skip-to ' + fmtClock(s);
          tick.style.cssText = [
            'position:absolute', 'top:50%', 'transform:translate(-50%,-50%)',
            'left:' + left + '%', 'width:2px', 'height:9px',
            'background:#fff', 'opacity:0.9', 'border-radius:1px'
          ].join(';');
          overlay.appendChild(tick);
        }
      }

      var cursor = 0;
      for (var i = 0; i < ranges.length; i++) {
        var ps = Math.max(0, ranges[i][0]);
        var pe = Math.min(dur, ranges[i][1]);
        if (ps > cursor) {
          addSeg(cursor, ps, 'skip', 'Skip ' + fmtClock(cursor) + ' → ' + fmtClock(ps));
        }
        addSeg(ps, pe, 'keep', 'Keep ' + fmtClock(ps) + ' – ' + fmtClock(pe));
        cursor = Math.max(cursor, pe);
      }
      if (cursor < dur) {
        addSeg(cursor, dur, 'skip', 'Skip ' + fmtClock(cursor) + ' → ' + fmtClock(dur));
      }
    } catch (e) { /* never break playback */ }
  }

  // ---------- badge ----------
  function stats() {
    var dur = STATE.videoDuration || getVideoDuration() || 0;
    var peakDur = 0;
    for (var i = 0; i < STATE.peakRanges.length; i++) {
      peakDur += Math.max(0, STATE.peakRanges[i][1] - STATE.peakRanges[i][0]);
    }
    if (!(dur > 0)) return { percentSkipped: 0, timeSavedSec: 0, peakDur: peakDur, duration: 0 };
    peakDur = Math.min(peakDur, dur);
    var skipped = Math.max(0, dur - peakDur);
    return {
      percentSkipped: Math.round((skipped / dur) * 1000) / 10,
      timeSavedSec: Math.round(skipped),
      peakDur: Math.round(peakDur),
      duration: Math.round(dur)
    };
  }

  function updateBadge() {
    try {
      if (!badgeEl || !badgeEl.isConnected) {
        badgeEl = document.getElementById('peakplay-badge');
        if (!badgeEl) {
          badgeEl = document.createElement('div');
          badgeEl.id = 'peakplay-badge';
          badgeEl.setAttribute('data-peakplay', 'true');
          badgeEl.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:999999',
            'font-family:Roboto,Arial,sans-serif', 'font-size:12px', 'font-weight:600',
            'padding:8px 12px', 'border-radius:20px', 'letter-spacing:.2px',
            'cursor:default', 'user-select:none', 'pointer-events:none',
            'box-shadow:0 4px 16px rgba(0,0,0,.45)', 'transition:opacity .25s'
          ].join(';');
          document.documentElement.appendChild(badgeEl);
        }
      }
      var s = stats();
      var label;
      if (!STATE.enabled) {
        badgeEl.style.background = '#3a3a3c';
        badgeEl.style.color = '#fff';
        label = 'PeakPlay OFF';
      } else if (STATE.perVideoOff) {
        badgeEl.style.background = '#3a3a3c';
        badgeEl.style.color = '#fff';
        label = 'PeakPlay off for this video';
      } else if (!STATE.heatmapFound) {
        badgeEl.style.background = '#5a5a5e';
        badgeEl.style.color = '#fff';
        label = 'PeakPlay: no heatmap';
      } else {
        badgeEl.style.background = '#0f9d58';
        badgeEl.style.color = '#fff';
        label = 'PeakPlay ON \u2022 ' + STATE.peakRanges.length + ' peaks \u2022 saves ~' + s.timeSavedSec + 's';
      }
      badgeEl.textContent = label;
      badgeEl.style.opacity = '0.92';
    } catch (e) { /* never break playback */ }
    renderTimelineOverlay();
  }

  // ---------- messaging ----------
  function handleMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'PEAKPLAY_GET_STATE') {
      var s = stats();
      sendResponse({
        enabled: STATE.enabled,
        k: STATE.k,
        contextEnabled: STATE.contextEnabled,
        maxSkipSec: STATE.maxSkipSec,
        contextKeepSec: STATE.contextKeepSec,
        gentleSkips: STATE.gentleSkips,
        perVideoOff: STATE.perVideoOff,
        peakCount: STATE.peakRanges.length,
        heatmapFound: STATE.heatmapFound,
        transcriptFound: STATE.transcriptFound,
        videoId: STATE.videoId,
        percentSkipped: s.percentSkipped,
        timeSavedSec: s.timeSavedSec,
        duration: s.duration,
        ready: STATE.ready
      });
      return true;
    }
    if (msg.type === 'PEAKPLAY_SET_ENABLED') {
      STATE.enabled = !!msg.enabled;
      try { chrome.storage.local.set({ enabled: STATE.enabled }); } catch (e) { /* ignore */ }
      updateBadge();
      sendResponse({ ok: true, enabled: STATE.enabled });
      return true;
    }
    if (msg.type === 'PEAKPLAY_SET_K') {
      var k = Number(msg.k);
      if (Number.isFinite(k)) {
        STATE.k = Math.min(1.5, Math.max(0.1, k));
        try { chrome.storage.local.set({ k: STATE.k }); } catch (e) { /* ignore */ }
        recomputeFromCache();
      }
      var s2 = stats();
      sendResponse({ ok: true, k: STATE.k, peakCount: STATE.peakRanges.length, percentSkipped: s2.percentSkipped, timeSavedSec: s2.timeSavedSec });
      return true;
    }
    if (msg.type === 'PEAKPLAY_SET_CONTEXT') {
      if (msg.contextEnabled !== undefined) {
        STATE.contextEnabled = !!msg.contextEnabled;
        try { chrome.storage.local.set({ contextEnabled: STATE.contextEnabled }); } catch (e) { /* ignore */ }
      }
      if (msg.maxSkipSec !== undefined) {
        var ms = Number(msg.maxSkipSec);
        if (Number.isFinite(ms)) {
          STATE.maxSkipSec = Math.min(120, Math.max(15, ms));
          try { chrome.storage.local.set({ maxSkipSec: STATE.maxSkipSec }); } catch (e) { /* ignore */ }
        }
      }
      if (STATE.rawHeatmap.length) recomputeFromCache();
      else updateBadge();
      var s3 = stats();
      sendResponse({
        ok: true,
        contextEnabled: STATE.contextEnabled,
        maxSkipSec: STATE.maxSkipSec,
        peakCount: STATE.peakRanges.length,
        percentSkipped: s3.percentSkipped,
        timeSavedSec: s3.timeSavedSec
      });
      return true;
    }
    if (msg.type === 'PEAKPLAY_SET_GENTLE') {
      STATE.gentleSkips = msg.gentleSkips !== false;
      try { chrome.storage.local.set({ gentleSkips: STATE.gentleSkips }); } catch (e) { /* ignore */ }
      cancelDeferredSkip();
      updateBadge();
      sendResponse({ ok: true, gentleSkips: STATE.gentleSkips });
      return true;
    }
    if (msg.type === 'PEAKPLAY_SET_PER_VIDEO') {
      var off = !!msg.off;
      STATE.perVideoOff = off;
      cancelDeferredSkip();
      try {
        chrome.storage.local.get({ skipBlocklist: [] }, function (items) {
          var list = Array.isArray(items.skipBlocklist) ? items.skipBlocklist : [];
          if (off) {
            if (STATE.videoId && list.indexOf(STATE.videoId) === -1) list.push(STATE.videoId);
          } else if (STATE.videoId) {
            list = list.filter(function (v) { return v !== STATE.videoId; });
          }
          try { chrome.storage.local.set({ skipBlocklist: list.slice(-200) }); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      updateBadge();
      sendResponse({ ok: true, perVideoOff: STATE.perVideoOff });
      return true;
    }
    return false;
  }

  // ---------- init / SPA ----------
  function isWatchPage() {
    try {
      return window.location.pathname === '/watch' && !!getVideoId();
    } catch (e) {
      return false;
    }
  }

  function dbg() {
    try {
      var args = ['[PeakPlay]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (!isWatchPage()) {
      dbg('not a watch page, skipping compute:', window.location.href);
      try {
        var b = document.getElementById('peakplay-badge');
        if (b) b.style.display = 'none';
      } catch (e) { /* ignore */ }
      return;
    }
    try {
      var b2 = document.getElementById('peakplay-badge');
      if (b2) b2.style.display = '';
    } catch (e2) { /* ignore */ }
    loadSettings().then(function () {
      attachToVideo();
      // Per-video opt-out survives reloads via blocklist.
      try {
        chrome.storage.local.get({ skipBlocklist: [] }, function (items) {
          var list = Array.isArray(items.skipBlocklist) ? items.skipBlocklist : [];
          STATE.perVideoOff = !!(STATE.videoId || getVideoId()) && list.indexOf(getVideoId()) !== -1;
          updateBadge();
        });
      } catch (e) { /* ignore */ }
      computeForCurrentVideo();
      updateBadge();
      // Deferred retry: playerResponse/heatmap often arrives late on SPA nav.
      setTimeout(function () {
        if (!STATE.heatmapFound && isWatchPage()) {
          dbg('retry compute (no heatmap on first pass)');
          attachToVideo();
          computeForCurrentVideo();
        }
      }, 2500);
      dbg('init', { videoId: STATE.videoId, enabled: STATE.enabled, k: STATE.k });
    });
  }

  function initObservers() {
    if (observerSetup) return;
    observerSetup = true;

    document.addEventListener('yt-navigate-finish', function () {
      setTimeout(init, 800);
    });

    // SPA fallback: watch URL changes.
    var lastUrl = location.href;
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (location.href.indexOf('/watch') !== -1) setTimeout(init, 800);
      }
    }, 1000);

    // Re-attach when YouTube swaps the <video> element (throttled: YT mutates DOM constantly).
    try {
      var moPending = false;
      var mo = new MutationObserver(function () {
        if (moPending) return;
        moPending = true;
        requestAnimationFrame(function () {
          moPending = false;
          try {
            var v = document.querySelector('video.html5-main-video') || document.querySelector('video');
            if (v && v !== videoEl) {
              attachToVideo();
              STATE.videoDuration = getVideoDuration();
              renderTimelineOverlay();
            } else if (STATE.ready && STATE.peakRanges.length) {
              // YouTube rebuilds the progress bar on quality/theater changes.
              var bar = document.querySelector('.ytp-progress-bar-container');
              var ov = document.getElementById('peakplay-timeline');
              if (bar && (!ov || !ov.isConnected)) renderTimelineOverlay();
            }
          } catch (e) { /* ignore */ }
        });
      });
      var playerRoot = document.getElementById('player') || document.documentElement;
      mo.observe(playerRoot, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }

    // Refresh duration metadata once available.
    document.addEventListener('loadedmetadata', function (e) {
      if (e && e.target && e.target.tagName === 'VIDEO') {
        STATE.videoDuration = getVideoDuration();
        updateBadge();
      }
    }, true);
  }

  try {
    chrome.runtime.onMessage.addListener(handleMessage);
  } catch (e) { /* ignore */ }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      var needsRecompute = false;
      if (changes.enabled) STATE.enabled = changes.enabled.newValue !== false;
      if (changes.k) {
        var k = Number(changes.k.newValue);
        if (Number.isFinite(k)) {
          STATE.k = Math.min(1.5, Math.max(0.1, k));
          needsRecompute = true;
        }
      }
      if (changes.contextEnabled) {
        STATE.contextEnabled = changes.contextEnabled.newValue !== false;
        needsRecompute = true;
      }
      if (changes.maxSkipSec) {
        var ms = Number(changes.maxSkipSec.newValue);
        if (Number.isFinite(ms)) {
          STATE.maxSkipSec = Math.min(120, Math.max(15, ms));
          needsRecompute = true;
        }
      }
      if (changes.contextKeepSec) {
        var ck = Number(changes.contextKeepSec.newValue);
        if (Number.isFinite(ck)) {
          STATE.contextKeepSec = Math.min(20, Math.max(3, ck));
          needsRecompute = true;
        }
      }
      if (changes.gentleSkips !== undefined) {
        STATE.gentleSkips = changes.gentleSkips.newValue !== false;
        cancelDeferredSkip();
      }
      if (changes.skipBlocklist) {
        try {
          var bl = Array.isArray(changes.skipBlocklist.newValue) ? changes.skipBlocklist.newValue : [];
          STATE.perVideoOff = !!STATE.videoId && bl.indexOf(STATE.videoId) !== -1;
        } catch (e) { /* ignore */ }
      }
      if (needsRecompute && STATE.rawHeatmap.length) recomputeFromCache();
      else updateBadge();
    });
  } catch (e) { /* ignore */ }

  initObservers();
  init();

  // Debug / manual-test API (use from YouTube page console).
  try {
    window.__PeakPlay = {
      state: STATE,
      stats: stats,
      recompute: recomputeFromCache,
      reinit: init,
      renderTimeline: renderTimelineOverlay,
      testSkipNext: function () {
        if (!videoEl) return 'no <video> element';
        var cur = videoEl.currentTime;
        var nxt = findNextPeak(cur);
        if (!nxt) return 'already in peak or no next peak @ ' + cur;
        smoothJumpTo(nxt[0] + 0.05);
        return 'jumped ' + cur + ' -> ' + nxt[0];
      },
      forcePeaks: function (ranges) {
        STATE.peakRanges = ranges;
        STATE.ready = true;
        STATE.heatmapFound = true;
        updateBadge();
        return STATE.peakRanges;
      }
    };
  } catch (e) { /* ignore */ }
})();

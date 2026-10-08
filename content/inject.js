/**
 * inject.js — runs in YouTube PAGE context (not isolated world).
 * Loaded via <script src=chrome.runtime.getURL> from content.js.
 * Reads window.ytInitialPlayerResponse directly and returns only
 * the small extracted payload via CustomEvent.
 */
(function () {
  'use strict';

  function deepCollectHeatMarkers(root) {
    var found = [];
    var seen = new Set();
    var stack = [root];
    var steps = 0;
    while (stack.length && steps < 30000) {
      steps += 1;
      var node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }
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
        var v = node[key];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return found;
  }

  function getCandidateResponses() {
    var cands = [];
    try {
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        cands.push({ name: 'ytInitialPlayerResponse', pr: window.ytInitialPlayerResponse });
      }
    } catch (e) { /* ignore */ }
    // Live player (has async-loaded heatmap that initial PR often lacks).
    try {
      var mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') {
        var live = mp.getPlayerResponse();
        if (live && typeof live === 'object') cands.push({ name: 'movie_player', pr: live });
      }
    } catch (e) { /* ignore */ }
    try {
      var cfg = window.ytplayer && window.ytplayer.config;
      if (cfg && cfg.args && cfg.args.player_response) {
        var raw = cfg.args.player_response;
        var pr2 = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (pr2 && typeof pr2 === 'object') cands.push({ name: 'ytplayer.config', pr: pr2 });
      }
    } catch (e) { /* ignore */ }
    return cands;
  }

  function findHeatKeyPaths(root, maxHits) {
    var hits = [];
    var seen = new Set();
    var stack = [{ node: root, path: '$' }];
    var steps = 0;
    while (stack.length && steps < 30000 && hits.length < (maxHits || 15)) {
      steps += 1;
      var item = stack.pop();
      var node = item.node, path = item.path;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], path: path + '[' + i + ']' });
        continue;
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var l = k.toLowerCase();
        if (l.indexOf('heat') !== -1 || l.indexOf('marker') !== -1 || l.indexOf('replay') !== -1 || l.indexOf('intensity') !== -1) {
          var v = node[k];
          hits.push(path + '.' + k + ' = ' + (Array.isArray(v) ? 'array[' + v.length + ']' : (v && typeof v === 'object' ? 'object' : String(v).slice(0, 60))));
          if (hits.length >= (maxHits || 15)) break;
        }
        var c = node[k];
        if (c && typeof c === 'object') stack.push({ node: c, path: path + '.' + k });
      }
    }
    return hits;
  }

  function extractPayload() {
    var cands = getCandidateResponses();

    if (!cands.length) {
      return { ok: false, reason: 'no-player-response', heatmap: [], captionUrl: null, duration: 0 };
    }

    var markers = [];
    var captionUrl = null;
    var duration = 0;
    var sources = [];
    var keyPaths = [];
    try {
      for (var ci = 0; ci < cands.length; ci++) {
        var mks = deepCollectHeatMarkers(cands[ci].pr);
        sources.push(cands[ci].name + ':' + mks.length);
        if (mks.length > markers.length) markers = mks;
        if (keyPaths.length < 15) {
          keyPaths = keyPaths.concat(findHeatKeyPaths(cands[ci].pr, 15 - keyPaths.length));
        }
      }
    } catch (e) { markers = []; }

    var pts = [];
    var byStart = {};
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var s = m.timeRangeStartMillis !== undefined ? m.timeRangeStartMillis : m.startMillis;
      var inten = m.heatMarkerIntensityScoreNormalized !== undefined
        ? m.heatMarkerIntensityScoreNormalized
        : m.intensityScoreNormalized;
      var d = m.markerDurationMillis !== undefined ? m.markerDurationMillis : m.durationMillis;
      s = Number(s);
      inten = Number(inten);
      if (!Number.isFinite(s) || !Number.isFinite(inten)) continue;
      var key = String(Math.round(s));
      var entry = { startMillis: s, intensityScoreNormalized: inten };
      if (d !== undefined && Number.isFinite(Number(d))) entry.markerDurationMillis = Number(d);
      if (!byStart[key] || byStart[key].intensityScoreNormalized < inten) byStart[key] = entry;
    }
    Object.keys(byStart).forEach(function (k) { pts.push(byStart[k]); });
    pts.sort(function (a, b) { return a.startMillis - b.startMillis; });

    var captionTracks = [];
    var captionUrl = null;
    var duration = 0;
    try {
      var list = null;
      for (var pi = 0; pi < cands.length && !captionTracks.length; pi++) {
        var pcl = cands[pi].pr;
        list = pcl.captions
          && pcl.captions.playerCaptionsTracklistRenderer
          && pcl.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (Array.isArray(list) && list.length) {
          captionTracks = list
            .filter(function (t) { return t && t.baseUrl; })
            .map(function (t) {
              return { url: t.baseUrl, lang: t.languageCode || '?', kind: t.kind || 'manual' };
            })
            .sort(function (a, b) {
              var score = function (t) {
                var s = ((t.lang || '').toLowerCase().indexOf('en') === 0) ? 0 : 2;
                if (t.kind === 'asr') s += 1;
                return s;
              };
              return score(a) - score(b) || String(a.lang).localeCompare(String(b.lang));
            });
          if (captionTracks.length) break;
        }
      }
      captionUrl = captionTracks.length ? captionTracks[0].url : null;
    } catch (e) { /* ignore */ }

    try {
      for (var di = 0; di < cands.length && !duration; di++) {
        duration = Number(cands[di].pr.videoDetails && cands[di].pr.videoDetails.lengthSeconds) || 0;
      }
    } catch (e) { /* ignore */ }

    if (!pts.length) {
      return {
        ok: false,
        reason: 'no-markers',
        heatmap: [],
        captionUrl: captionUrl,
        captionTracks: captionTracks,
        duration: duration,
        sources: sources,
        keyPaths: keyPaths
      };
    }

    return {
      ok: true,
      heatmap: pts,
      captionUrl: captionUrl,
      captionTracks: captionTracks,
      duration: duration,
      markerCount: pts.length,
      sources: sources,
      keyPaths: keyPaths
    };
  }

  document.addEventListener('PEAKPLAY_REQUEST', function (ev) {
    var reqId = null;
    try { reqId = ev && ev.detail && ev.detail.reqId; } catch (e) { /* ignore */ }
    var payload;
    try {
      payload = extractPayload();
    } catch (e) {
      payload = { ok: false, reason: 'extract-threw', heatmap: [], captionUrl: null, duration: 0 };
    }
    payload.reqId = reqId || null;
    document.dispatchEvent(new CustomEvent('PEAKPLAY_RESPONSE', { detail: payload }));
  });
})();

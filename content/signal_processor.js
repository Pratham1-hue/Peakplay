/**
 * signal_processor.js
 * Pure signal-processing for PeakPlay.
 * Exposes: detectPeaks(heatmapData, kSensitivity, mergeGapSec)
 *
 * heatmapData input formats supported (all normalized internally):
 *   [{ startMillis, intensityScoreNormalized }]
 *   [{ startSec, intensity }]
 *   [{ start, end, intensity }]
 *   [{ timeRangeStartMillis, heatMarkerIntensityScoreNormalized, markerDurationMillis }]
 */

(function (global) {
  'use strict';

  function toNumber(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function pickField(obj, keys, fallback) {
    for (var i = 0; i < keys.length; i++) {
      if (obj != null && obj[keys[i]] !== undefined && obj[keys[i]] !== null) {
        return obj[keys[i]];
      }
    }
    return fallback;
  }

  /**
   * Normalize arbitrary heatmap marker objects to
   * [{ start, end, intensity }] sorted by start (seconds).
   */
  function normalizeHeatmap(heatmapData) {
    if (!Array.isArray(heatmapData) || heatmapData.length === 0) return [];

    var pts = [];
    for (var i = 0; i < heatmapData.length; i++) {
      var m = heatmapData[i];
      if (m == null) continue;

      // start
      var startRaw = pickField(m, [
        'start',
        'startSec',
        'startSeconds',
        'startMillis',
        'startMs',
        'timeRangeStartMillis',
        't'
      ], null);

      var start;
      if (startRaw === null || startRaw === undefined) {
        // fall back to index-based (caller should supply duration context)
        start = null;
      } else if (
        m.startMillis !== undefined || m.startMs !== undefined ||
        m.timeRangeStartMillis !== undefined
      ) {
        start = toNumber(startRaw, NaN) / 1000.0;
      } else {
        start = toNumber(startRaw, NaN);
      }

      // intensity
      var intRaw = pickField(m, [
        'intensity',
        'intensityScore',
        'intensityScoreNormalized',
        'heatMarkerIntensityScoreNormalized',
        'heatMarkerIntensityScore',
        'value',
        'score'
      ], NaN);
      var intensity = toNumber(intRaw, NaN);

      // end / duration
      var endRaw = pickField(m, ['end', 'endSec', 'endSeconds', 'endMillis'], null);
      var durRaw = pickField(m, [
        'duration',
        'durationSec',
        'markerDurationMillis',
        'durationMillis',
        'dur'
      ], null);

      var end = null;
      if (endRaw !== null && endRaw !== undefined) {
        if (m.endMillis !== undefined) end = toNumber(endRaw, NaN) / 1000.0;
        else end = toNumber(endRaw, NaN);
      } else if (durRaw !== null && durRaw !== undefined) {
        var d = toNumber(durRaw, NaN);
        if (m.markerDurationMillis !== undefined || m.durationMillis !== undefined) d = d / 1000.0;
        if (Number.isFinite(start) && Number.isFinite(d)) end = start + d;
      }

      if (!Number.isFinite(start) || !Number.isFinite(intensity)) continue;
      pts.push({ start: start, end: end, intensity: intensity });
    }

    pts.sort(function (a, b) { return a.start - b.start; });

    // Fill missing ends from next start; last marker gets median duration.
    var durations = [];
    for (var j = 0; j < pts.length - 1; j++) {
      var gap = pts[j + 1].start - pts[j].start;
      if (gap > 0 && gap < 120) durations.push(gap);
    }
    durations.sort(function (a, b) { return a - b; });
    var medianDur = durations.length
      ? durations[Math.floor(durations.length / 2)]
      : 1.0;

    for (var k = 0; k < pts.length; k++) {
      if (!Number.isFinite(pts[k].end) || pts[k].end <= pts[k].start) {
        if (k < pts.length - 1 && pts[k + 1].start > pts[k].start) {
          pts[k].end = pts[k + 1].start;
        } else {
          pts[k].end = pts[k].start + medianDur;
        }
      }
    }

    return pts;
  }

  function smoothEMA(values, alpha) {
    if (!values.length) return [];
    if (!(alpha > 0 && alpha <= 1)) alpha = 0.35;
    var out = new Array(values.length);
    out[0] = values[0];
    for (var i = 1; i < values.length; i++) {
      out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
    }
    return out;
  }

  function meanStd(values) {
    var n = values.length;
    if (!n) return { mean: 0, std: 0 };
    var s = 0;
    for (var i = 0; i < n; i++) s += values[i];
    var mean = s / n;
    var v = 0;
    for (var j = 0; j < n; j++) {
      var d = values[j] - mean;
      v += d * d;
    }
    v = v / n;
    return { mean: mean, std: Math.sqrt(v) };
  }

  /**
   * Detect peak engagement intervals.
   * @param {Array} heatmapData - raw markers (see normalizeHeatmap)
   * @param {number} kSensitivity - threshold multiplier (default 0.5)
   * @param {number} mergeGapSec - merge blocks closer than this (default 3)
   * @returns {Array<Array<number>>} list of [startSec, endSec]
   */
  function detectPeaks(heatmapData, kSensitivity, mergeGapSec) {
    var k = toNumber(kSensitivity, 0.5);
    if (!Number.isFinite(k)) k = 0.5;
    k = Math.min(2.0, Math.max(0.05, k));

    var mergeGap = toNumber(mergeGapSec, 3);
    if (!Number.isFinite(mergeGap) || mergeGap < 0) mergeGap = 3;

    var pts = normalizeHeatmap(heatmapData);
    if (pts.length === 0) return [];
    if (pts.length === 1) return [[pts[0].start, pts[0].end]];

    var raw = pts.map(function (p) { return p.intensity; });
    var smoothed = smoothEMA(raw, 0.35);
    var stats = meanStd(smoothed);
    var threshold = stats.mean + k * stats.std;

    // Flat signal -> keep everything (nothing to skip).
    if (!(stats.std > 1e-9)) {
      return [[pts[0].start, pts[pts.length - 1].end]];
    }

    // Contiguous blocks above threshold.
    var blocks = [];
    var cur = null;
    for (var i = 0; i < pts.length; i++) {
      if (smoothed[i] >= threshold) {
        if (!cur) cur = { from: i, to: i };
        else cur.to = i;
      } else if (cur) {
        blocks.push(cur);
        cur = null;
      }
    }
    if (cur) blocks.push(cur);
    if (!blocks.length) {
      // Overly strict k -> fall back to top quartile of markers.
      var order = smoothed
        .map(function (v, idx) { return { v: v, idx: idx }; })
        .sort(function (a, b) { return b.v - a.v; });
      var keep = Math.max(1, Math.floor(order.length * 0.25));
      var idxSet = {};
      for (var q = 0; q < keep; q++) idxSet[order[q].idx] = true;
      var idxs = Object.keys(idxSet).map(Number).sort(function (a, b) { return a - b; });
      cur = null;
      blocks = [];
      for (var r = 0; r < idxs.length; r++) {
        if (!cur) cur = { from: idxs[r], to: idxs[r] };
        else if (idxs[r] === cur.to + 1) cur.to = idxs[r];
        else { blocks.push(cur); cur = { from: idxs[r], to: idxs[r] }; }
      }
      if (cur) blocks.push(cur);
    }

    var ranges = blocks.map(function (b) {
      return [pts[b.from].start, pts[b.to].end];
    });

    // Merge adjacent blocks separated by < mergeGap.
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    for (var m = 0; m < ranges.length; m++) {
      var rg = ranges[m];
      if (!merged.length) merged.push([rg[0], rg[1]]);
      else {
        var last = merged[merged.length - 1];
        if (rg[0] - last[1] < mergeGap) {
          last[1] = Math.max(last[1], rg[1]);
        } else {
          merged.push([rg[0], rg[1]]);
        }
      }
    }

    // Drop micro-blips (<0.8s) unless it is the only peak.
    var MIN_PEAK = 0.8;
    if (merged.length > 1) {
      merged = merged.filter(function (rg) { return rg[1] - rg[0] >= MIN_PEAK; });
    }
    if (!merged.length) {
      // keep the longest raw range as safety
      ranges.sort(function (a, b) { return (b[1] - b[0]) - (a[1] - a[0]); });
      return [ranges[0]];
    }

    // Round to 2 decimals for stable seeking.
    return merged.map(function (rg) {
      return [Math.max(0, Math.round(rg[0] * 100) / 100), Math.round(rg[1] * 100) / 100];
    });
  }

  /**
   * Insert small "context keep" windows into long skip gaps so the story
   * stays followable: play a little bit here, a little bit there.
   * @param {Array} peakRanges [[s,e],...] sorted
   * @param {number} totalDuration video duration seconds
   * @param {number} maxSkipSec never skip longer than this without a context bite (default 45)
   * @param {number} keepSec length of each context bite (default 8)
   * @returns {Array} expanded ranges
   */
  function addContextKeeps(peakRanges, totalDuration, maxSkipSec, keepSec) {
    var maxSkip = toNumber(maxSkipSec, 45);
    var keep = toNumber(keepSec, 8);
    if (!Number.isFinite(maxSkip) || maxSkip < 10) maxSkip = 45;
    if (!Number.isFinite(keep) || keep < 2) keep = 8;
    var dur = toNumber(totalDuration, 0);
    if (!(dur > 0)) return (peakRanges || []).slice();
    var peaks = (peakRanges || []).slice().sort(function (a, b) { return a[0] - b[0]; });

    // Always keep the opening hook so context starts cleanly.
    var withHook = [];
    var HOOK = Math.min(6, dur);
    withHook.push([0, HOOK]);
    for (var i = 0; i < peaks.length; i++) withHook.push(peaks[i]);
    peaks = withHook;

    var out = [];
    var cursor = 0;
    function pushGapKeeps(gapStart, gapEnd) {
      var gapLen = gapEnd - gapStart;
      if (!(gapLen > maxSkip)) return;
      // Place a keep bite every maxSkip seconds, centered in each chunk.
      var pos = gapStart + maxSkip;
      while (pos + keep / 2 < gapEnd) {
        var ks = Math.max(gapStart + 1, pos - keep / 2);
        var ke = Math.min(gapEnd - 1, ks + keep);
        if (ke > ks + 1) out.push([Math.round(ks * 100) / 100, Math.round(ke * 100) / 100]);
        pos += maxSkip + keep;
      }
    }

    for (var j = 0; j < peaks.length; j++) {
      var ps = Math.max(0, peaks[j][0]);
      var pe = Math.min(dur, peaks[j][1]);
      if (ps > cursor + 0.5) pushGapKeeps(cursor, ps);
      out.push([ps, pe]);
      cursor = Math.max(cursor, pe);
    }
    if (cursor < dur - 0.5) pushGapKeeps(cursor, dur);

    out.sort(function (a, b) { return a[0] - b[0]; });
    // Merge overlaps / near-touching (2s) since context bites are dense.
    var merged = [];
    for (var m = 0; m < out.length; m++) {
      if (!merged.length) merged.push(out[m]);
      else {
        var last = merged[merged.length - 1];
        if (out[m][0] - last[1] < 2) last[1] = Math.max(last[1], out[m][1]);
        else merged.push(out[m]);
      }
    }
    return merged;
  }

  global.detectPeaks = detectPeaks;
  global.addContextKeeps = addContextKeeps;
  global.__PeakPlaySignal = {
    detectPeaks: detectPeaks,
    addContextKeeps: addContextKeeps,
    normalizeHeatmap: normalizeHeatmap,
    smoothEMA: smoothEMA
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectPeaks: detectPeaks, addContextKeeps: addContextKeeps };
  }
})(typeof window !== 'undefined' ? window : globalThis);

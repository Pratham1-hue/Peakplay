/**
 * transcript_snapper.js
 * Snaps raw peak ranges to sentence / speech-pause boundaries.
 * Exposes: snapToSentenceBoundaries(peakRanges, transcriptSegments, options)
 *
 * peakRanges: [[startSec, endSec], ...]
 * transcriptSegments: [{ start, duration, end?, text }, ...] (seconds)
 */

(function (global) {
  'use strict';

  var SENT_END_RE = /[.!?\u2026\u0964\u0965"'\u201d)\]]\s*$/;
  var SENT_START_UPPER_RE = /^[A-Z\u00C0-\u024F0-9"\u201c\(\[]/;

  function toNum(v, fb) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }

  function splitSentences(text) {
    // Keep delimiters; handles . ? ! … । ॥
    var parts = String(text).match(/[^.!?\u2026\u0964\u0965]+[.!?\u2026\u0964\u0965]+["'\u201d)\]]*\s*|[^.!?\u2026\u0964\u0965]+$/g);
    if (!parts) return [text];
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }

  function normalizeSegments(segs) {
    if (!Array.isArray(segs)) return [];
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s == null) continue;
      var start = toNum(s.start !== undefined ? s.start : s.tStartMs !== undefined ? s.tStartMs / 1000 : s.t, NaN);
      // support ms fields
      if (s.startMs !== undefined) start = toNum(s.startMs, NaN) / 1000;
      if (s.startMillis !== undefined) start = toNum(s.startMillis, NaN) / 1000;
      var dur = toNum(
        s.duration !== undefined ? s.duration
          : s.dur !== undefined ? s.dur
          : s.dDurationMs !== undefined ? s.dDurationMs / 1000
          : NaN,
        NaN
      );
      var end = s.end !== undefined ? toNum(s.end, NaN) : NaN;
      if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(dur)) end = start + dur;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      var text = (s.text !== undefined && s.text !== null) ? String(s.text) : '';
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (end < start) { var t = start; start = end; end = t; }
      // Split multi-sentence caption chunks so snapping can land
      // INSIDE a chunk at a true sentence boundary (time-interpolated).
      var sentences = splitSentences(text);
      if (sentences.length > 1) {
        var totalChars = sentences.reduce(function (a, p) { return a + p.length; }, 0) || 1;
        var cursor = start;
        for (var k = 0; k < sentences.length; k++) {
          var share = sentences[k].length / totalChars;
          var subDur = (end - start) * share;
          // Last sentence takes remainder to avoid rounding drift.
          var subEnd = (k === sentences.length - 1) ? end : cursor + subDur;
          if (subEnd > cursor + 0.15) {
            out.push({ start: cursor, end: subEnd, duration: subEnd - cursor, text: sentences[k] });
          }
          cursor = subEnd;
        }
      } else {
        out.push({ start: start, end: end, duration: end - start, text: text });
      }
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  function isFullStopStart(segs, idx) {
    if (idx <= 0) return true;
    if (SENT_END_RE.test(segs[idx - 1].text)) return true;
    return false;
  }

  function isFullStopEnd(segs, idx) {
    if (SENT_END_RE.test(segs[idx].text)) return true;
    if (idx >= segs.length - 1) return true;
    return false;
  }

  function isSentenceStart(segs, idx, pauseThreshold) {
    if (idx <= 0) return true;
    var prev = segs[idx - 1];
    var cur = segs[idx];
    var gap = cur.start - prev.end;
    if (gap >= pauseThreshold) return true;
    if (SENT_END_RE.test(prev.text)) return true;
    // Uppercase start after non-comma ending is a weak sentence cue.
    if (SENT_START_UPPER_RE.test(cur.text) && !/[,;:]\s*$/.test(prev.text)) return true;
    return false;
  }

  function isSentenceEnd(segs, idx, pauseThreshold) {
    var cur = segs[idx];
    if (SENT_END_RE.test(cur.text)) return true;
    if (idx >= segs.length - 1) return true;
    var next = segs[idx + 1];
    var gap = next.start - cur.end;
    if (gap >= pauseThreshold) return true;
    if (SENT_START_UPPER_RE.test(next.text) && !/[,;:]\s*$/.test(cur.text)) return true;
    return false;
  }

  function findContainingOrBefore(segs, t) {
    var lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function findFirstEndAfter(segs, t) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].end >= t) return i;
    }
    return segs.length - 1;
  }

  /**
   * Snap peaks to sentence boundaries.
   * @param {Array} peakRanges [[s,e],...]
   * @param {Array} transcriptSegments [{start,duration,text},...]
   * @param {Object} options {pauseThreshold, preRoll, postRoll, maxWalk, fullStopOnly}
   *   fullStopOnly: snap ends/starts only at [.?!…] full stops; falls back to
   *   pause-based snapping when no full stop is found within maxWalk.
   */
  function snapToSentenceBoundaries(peakRanges, transcriptSegments, options) {
    var opts = options || {};
    var pauseThreshold = toNum(opts.pauseThreshold, 0.4);
    var preRoll = toNum(opts.preRoll, 0.15);
    var postRoll = toNum(opts.postRoll, 0.25);
    var maxWalk = Math.max(1, Math.floor(toNum(opts.maxWalk, 12)));
    var fullStopOnly = !!opts.fullStopOnly;

    if (!Array.isArray(peakRanges) || peakRanges.length === 0) return [];

    var segs = normalizeSegments(transcriptSegments);

    // No transcript -> wider buffering + merge so cuts land in silence, not mid-word.
    if (!segs.length) {
      var buffered = peakRanges.map(function (r) {
        var s = Math.max(0, toNum(r[0], 0) - 0.8);
        var e = Math.max(s + 0.5, toNum(r[1], s) + 1.0);
        return [s, e];
      });
      return mergeRanges(buffered);
    }

    var snapped = peakRanges.map(function (r) {
      var ps = toNum(r[0], 0);
      var pe = toNum(r[1], ps);
      if (pe < ps) { var tmp = ps; ps = pe; pe = tmp; }

      // --- snap start backward (full stop preferred) ---
      var si = findContainingOrBefore(segs, ps);
      if (si < 0) si = 0;
      // If ps falls inside a gap after segs[si].end, keep si (the preceding cue).
      var steps = 0;
      if (fullStopOnly) {
        while (si > 0 && !isFullStopStart(segs, si) && steps < maxWalk) {
          si -= 1;
          steps += 1;
        }
        // No full stop in range (e.g. unpunctuated auto-captions): pause fallback.
        if (si > 0 && !isFullStopStart(segs, si)) {
          si = findContainingOrBefore(segs, ps);
          if (si < 0) si = 0;
          steps = 0;
          while (si > 0 && !isSentenceStart(segs, si, pauseThreshold) && steps < maxWalk) {
            si -= 1;
            steps += 1;
          }
        }
      } else {
        while (si > 0 && !isSentenceStart(segs, si, pauseThreshold) && steps < maxWalk) {
          si -= 1;
          steps += 1;
        }
      }
      var snappedStart = Math.max(0, segs[si].start - preRoll);

      // --- snap end forward (full stop preferred) ---
      var ei = findFirstEndAfter(segs, pe);
      steps = 0;
      if (fullStopOnly) {
        while (ei < segs.length - 1 && !isFullStopEnd(segs, ei) && steps < maxWalk) {
          ei += 1;
          steps += 1;
        }
        if (ei < segs.length - 1 && !isFullStopEnd(segs, ei)) {
          ei = findFirstEndAfter(segs, pe);
          steps = 0;
          while (ei < segs.length - 1 && !isSentenceEnd(segs, ei, pauseThreshold) && steps < maxWalk) {
            ei += 1;
            steps += 1;
          }
        }
      } else {
        while (ei < segs.length - 1 && !isSentenceEnd(segs, ei, pauseThreshold) && steps < maxWalk) {
          ei += 1;
          steps += 1;
        }
      }
      var snappedEnd = segs[ei].end + postRoll;

      if (snappedEnd <= snappedStart) snappedEnd = snappedStart + 0.5;
      return [snappedStart, snappedEnd];
    });

    snapped.sort(function (a, b) { return a[0] - b[0]; });
    var merged = mergeRanges(snapped);

    return merged.map(function (rg) {
      return [Math.round(rg[0] * 100) / 100, Math.round(rg[1] * 100) / 100];
    });
  }

  function mergeRanges(ranges) {
    if (!ranges.length) return [];
    var sorted = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [[sorted[0][0], sorted[0][1]]];
    for (var i = 1; i < sorted.length; i++) {
      var last = out[out.length - 1];
      var cur = sorted[i];
      if (cur[0] <= last[1] + 0.05) {
        last[1] = Math.max(last[1], cur[1]);
      } else {
        out.push([cur[0], cur[1]]);
      }
    }
    return out;
  }

  global.snapToSentenceBoundaries = snapToSentenceBoundaries;
  global.__PeakPlaySnapper = {
    snapToSentenceBoundaries: snapToSentenceBoundaries,
    normalizeSegments: normalizeSegments
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { snapToSentenceBoundaries: snapToSentenceBoundaries };
  }
})(typeof window !== 'undefined' ? window : globalThis);

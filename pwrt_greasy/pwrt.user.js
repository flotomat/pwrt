// ==UserScript==
// @name         PWRT – Personal War Report Tool
// @namespace    https://greasyfork.org/scripts/pwrt
// @version      1.1.0
// @description  Personal War Report Tool for Torn – shows your ranked-war statistics on the Factions page. Works in Torn PDA (iOS/Android) and desktop browsers with Tampermonkey/Violentmonkey. On first use you will be prompted for your Torn API key (Limited access or higher).
// @author       PWRT
// @homepageURL  https://github.com/flotomat/pwrt
// @supportURL   https://github.com/flotomat/pwrt/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/flotomat/pwrt@main/pwrt_greasy/pwrt.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/flotomat/pwrt@main/pwrt_greasy/pwrt.user.js
// @match        https://www.torn.com/factions.php*
// @include      https://www.torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        torn_api_key
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

/* ============================================================
   PWRT – Personal War Report Tool  (Userscript Edition)
   Funktionsgleich mit dem PHP-Report.
   Anforderungen: Torn API Key (mindestens "Limited", für
   vollständige Last-Action-Analyse "Full Access").
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const API_V2 = 'https://api.torn.com/v2';
  const API_V1 = 'https://api.torn.com';
  const KEY_STORE  = 'pwrt_api_key';
  const DATE_STORE = 'pwrt_last_date';

  // Torn PDA replaces ###PDA-APIKEY### with the user's API key at inject time.
  // _PDA_KEY_MARKER is split so Torn PDA does NOT replace it (used for comparison).
  const _PDA_KEY_MARKER  = '###PDA' + '-APIKEY###';
  const PDA_INJECTED_KEY = '###PDA-APIKEY###';
  const key = '###PDA-APIKEY###';

  // ── Storage helpers (GM_ or localStorage fallback for Torn PDA) ───
  function storeGet(key, def) {
    try { return (typeof GM_getValue === 'function') ? GM_getValue(key, def) : (localStorage.getItem(key) ?? def); }
    catch (e) { return def; }
  }
  function storeSet(key, val) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, val); else localStorage.setItem(key, String(val)); }
    catch (e) {}
  }

  // ── Torn PDA detection & platform readiness ─────────────────
  function isInTornPDA() {
    try { return typeof window.flutter_inappwebview?.callHandler === 'function'; }
    catch(e) { return false; }
  }

  // Torn PDA fires 'flutterInAppWebViewPlatformReady' once callHandler is usable.
  // NOTE: isInTornPDA() already verifies callHandler IS a function, so if it returns
  // true, the platform is ready right now. The event may have fired before our listener
  // was registered (script runs at document-idle) – hence we must NOT wait when
  // isInTornPDA() is already true, otherwise we waste 5 seconds every call.
  var _pdaPlatformReady = false;
  window.addEventListener('flutterInAppWebViewPlatformReady', function() {
    _pdaPlatformReady = true;
  });
  function waitForPlatformReady() {
    return new Promise(function(resolve) {
      // Not in PDA at all → no need to wait
      if (!isInTornPDA()) { resolve(); return; }
      // isInTornPDA() checks typeof callHandler === 'function', meaning it IS
      // accessible right now → the platform is already ready → resolve immediately.
      // (If callHandler were not ready yet, isInTornPDA() would return false.)
      resolve();
    });
  }

  // ── GM_xmlhttpRequest → Promise ────────────────────────────
  // Priority: 1) GM_xmlhttpRequest (Tampermonkey/Violentmonkey)
  //           2) PDA_httpGet via flutter_inappwebview (Torn PDA – bypasses CORS)
  //           3) fetch() browser fallback
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 30000,
          onload(r) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('Invalid JSON: ' + r.responseText.slice(0, 120))); }
          },
          onerror(r) { reject(new Error('Network error: ' + (r.statusText || r.status))); },
          ontimeout()  { reject(new Error('Request timed out')); },
        });
      } else if (isInTornPDA()) {
        // Torn PDA native HTTP handler – must wait for platform readiness first
        waitForPlatformReady().then(function() {
          return window.flutter_inappwebview.callHandler('PDA_httpGet', url, {});
        }).then(function(r) {
          if (r.status >= 400) { reject(new Error('HTTP ' + r.status)); return; }
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('Invalid JSON: ' + String(r.responseText).slice(0, 120))); }
        }).catch(reject);
      } else {
        // Plain browser fallback (may fail due to CORS on api.torn.com)
        fetch(url, { credentials: 'omit' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(resolve)
          .catch(reject);
      }
    });
  }

  function buildUrl(base, params) {
    const q = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return q ? base + '?' + q : base;
  }

  function apiV2(path, params, key) {
    return gmFetch(buildUrl(`${API_V2}/${path.replace(/^\//, '')}`, { ...params, key }));
  }

  function apiV1Events(toTs, key) {
    return gmFetch(buildUrl(`${API_V1}/user/`, { selections: 'events', to: toTs, key }));
  }

  // ── Key permission check ────────────────────────────────────
  async function checkKeyPermissions(key) {
    if (!key) return [null, 'No API key entered.'];

    // Step 1: try V2 key/info for access-level detection.
    // Response: { "info": { "access": { "level": 4 } } }
    try {
      const data = await gmFetch(buildUrl(`${API_V2}/key/info`, { key }));
      if (!data.error) {
        const level = parseInt(
          data.info?.access?.level ??
          data.key?.access_level  ??
          data.key?.accessLevel   ??
          0, 10);
        if (level >= 4) return ['full', null];
        if (level >= 3) return ['limited', null];
        // level 0 likely means wrong response shape – fall through to validation
        if (level > 0) return [null, `API key has insufficient access (level ${level}). Need "Limited" (3) or higher.`];
      }
    } catch (_) { /* network error – fall through */ }

    // Step 2: key/info failed or returned unexpected shape.
    // Validate via user/basic (which is needed in runReport anyway).
    // If this succeeds the key is valid; assume "limited" access level.
    try {
      const basic = await gmFetch(buildUrl(`${API_V2}/user/basic`, { key }));
      if (basic.error) return [null, `API error ${basic.error.code}: ${basic.error.error}`];
      // Key is valid – we just can't determine the exact level; proceed as limited.
      return ['limited', null];
    } catch (e) {
      return [null, 'Network error during key check: ' + e.message];
    }
  }

  // ── Date helpers ────────────────────────────────────────────
  function parseDateStr(s) {
    // "DD.MM.YYYY" → unix timestamp at 23:59:59 (local time)
    const [d, m, y] = s.split('.').map(Number);
    return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
  }

  function fmtTs(ts) {
    const d = new Date(ts * 1000);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  function fmtDur(s) {
    if (s == null) return 'N/A';
    s = Math.round(s);
    if (s < 60)    return `${s}s`;
    if (s < 3600)  return `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86400) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}h ${m}m`; }
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return `${d}d ${h}h`;
  }

  function fmtUtc(ts) {
    const d = new Date(ts * 1000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0') + ' ' +
      String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
  }

  function todayStr() {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + '.' +
           String(d.getMonth() + 1).padStart(2, '0') + '.' +
           d.getFullYear();
  }

  function nf(v, dec = 2) { return Number(v).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Torn PDA API key detection ──────────────────────────────
  // Primary: Torn PDA replaces ###PDA-APIKEY### in the source at inject time.
  // If PDA_INJECTED_KEY differs from _PDA_KEY_MARKER, the replacement happened.
  // Fallback: window.torn_api_key from @grant torn_api_key (older PDA versions).
  function getPDAApiKey() {
    if (PDA_INJECTED_KEY !== _PDA_KEY_MARKER) return PDA_INJECTED_KEY;
    try {
      return window?.torn_api_key
          ?? window?.TornAPI?.key
          ?? window?.TornPDA?.apiKey
          ?? window?.TornPDA?.key
          ?? window?.TornAPIKey
          ?? null;
    } catch (e) { return null; }
  }

  // ── Player info ─────────────────────────────────────────────
  async function getPlayerInfo(key) {
    const [basic, facData] = await Promise.all([
      apiV2('user/basic', {}, key),
      apiV2('user/faction', {}, key),
    ]);
    const playerId  = basic.profile?.id ?? null;
    const fac       = facData.faction ?? {};
    const factionId = fac.faction_id ?? fac.id ?? null;
    return [playerId, factionId];
  }

  // ── War detection (V1 events) ───────────────────────────────
  async function getWarStartAndOpponent(searchTs, factionId, key) {
    const data   = await apiV1Events(searchTs, key);
    const events = data.events ?? {};
    for (const entry of Object.values(events)) {
      const text = entry.event ?? '';
      if (!text.startsWith('The ranked war between') || !text.includes('has begun')) continue;
      const ts   = parseInt(entry.timestamp, 10);
      const ids  = [...text.matchAll(/ID=(\d+)/g)].map(m => m[1]);
      const oppId = ids.find(id => String(id) !== String(factionId)) ?? null;
      let oppName = null;
      if (oppId) {
        const m = text.match(new RegExp(`ID=${oppId}">([^<]+)</a>`));
        oppName = m ? m[1] : null;
      }
      return [ts, oppId, oppName];
    }
    return [null, null, null];
  }

  async function findWarEnd(startTs, key) {
    const maxEnd = startTs + 123 * 3600;
    const data   = await apiV1Events(maxEnd, key);
    for (const entry of Object.values(data.events ?? {})) {
      const text = entry.event ?? '';
      const ts   = parseInt(entry.timestamp, 10);
      if (text.includes('defeated') && text.includes('in a ranked war') && ts >= startTs) {
        return Math.min(ts, maxEnd);
      }
    }
    return maxEnd;
  }

  async function getWarResult(startTs, oppId, key) {
    const maxEnd = startTs + 123 * 3600;
    const data   = await apiV1Events(maxEnd, key);
    for (const entry of Object.values(data.events ?? {})) {
      const text = entry.event ?? '';
      const ts   = parseInt(entry.timestamp, 10);
      if (ts < startTs || !text.includes('defeated') || !text.includes('in a ranked war')) continue;
      const scores = [...text.matchAll(/(\d+)\s*(?:to|-)\s*(\d+)/g)];
      const ownScore = scores.length ? parseInt(scores[0][1], 10) : null;
      const oppScore = scores.length ? parseInt(scores[0][2], 10) : null;
      const result   = (text.includes('has defeated') && oppId && text.includes(String(oppId)))
        ? 'Lost' : 'Won';
      return { result, ownScore, oppScore };
    }
    return { result: 'Unknown (war ongoing or result not found)', ownScore: null, oppScore: null };
  }

  // ── Fetch attacks (V2, paginated) ───────────────────────────
  async function getAttacksV2(startTs, endTs, key) {
    let all  = [];
    let data = await apiV2('user/attacks', { from: startTs, to: endTs, limit: 1000 }, key);
    all = all.concat(data.attacks ?? []);
    let next = data._metadata?.links?.next ?? null;
    while (next) {
      data = await gmFetch(next);
      all  = all.concat(data.attacks ?? []);
      next = data._metadata?.links?.next ?? null;
    }
    return all;
  }

  // ── Fetch logs (V2, cursor-based) ───────────────────────────
  async function getLogsV2(startTs, endTs, key) {
    let all  = [];
    let currentTo = endTs;
    while (true) {
      const data = await apiV2('user/log', { to: currentTo, limit: 100 }, key);
      const page = data.log ?? [];
      if (!page.length) break;
      for (const entry of page) {
        if (parseInt(entry.timestamp, 10) >= startTs) all.push(entry);
      }
      const oldest = Math.min(...page.map(e => parseInt(e.timestamp, 10)));
      if (oldest <= startTs || page.length < 100) break;
      currentTo = oldest - 1;
    }
    return all;
  }

  // ── Log analysis ────────────────────────────────────────────
  function logCategory(entry) {
    const d = entry.details ?? {};
    if (typeof d !== 'object') return '';
    return ((d.category ?? d.title) ?? '').toLowerCase();
  }

  function isMedical(entry) {
    const cat = logCategory(entry);
    return cat.includes('item use') ||
      ['first aid','blood bag','morphine','adrenaline','epinephrine','syringe','bandage','med kit','medikit']
        .some(kw => cat.includes(kw));
  }

  function isHospitalRelease(entry) {
    return logCategory(entry).includes('hospital');
  }

  function findLastActionBefore(sortedLogs, attackTs) {
    let bestTs = null, bestEntry = null;
    for (const entry of sortedLogs) {
      const lt = parseInt(entry.timestamp, 10);
      if (lt < attackTs) {
        if (bestTs === null || lt > bestTs) { bestTs = lt; bestEntry = entry; }
      } else break;
    }
    if (!bestEntry) return ['N/A', null];
    const d = bestEntry.details ?? {};
    const action = typeof d === 'object' ? (d.title ?? d.category ?? 'Unknown') : String(d || 'Unknown');
    return [action, attackTs - bestTs];
  }

  function findNotableEventBefore(sortedLogs, attackTs, window = 1800) {
    for (let i = sortedLogs.length - 1; i >= 0; i--) {
      const entry = sortedLogs[i];
      const lt    = parseInt(entry.timestamp, 10);
      if (lt >= attackTs) continue;
      if (lt < attackTs - window) break;
      if (isMedical(entry) || isHospitalRelease(entry)) return [entry, attackTs - lt];
    }
    return [null, null];
  }

  function countOutgoingInWindow(outgoing, fromTs, toTs) {
    let count = 0, total = 0;
    for (const atk of outgoing) {
      const ts = atkTs(atk);
      if (ts >= fromTs && ts < toTs) { count++; total += parseFloat(atk.respect_gain ?? atk.respect ?? 0); }
    }
    return [count, total];
  }

  function analyzeBehavior(incoming, sortedLogs) {
    if (!sortedLogs.length || !incoming.length) return new Set();
    const highlighted = new Set();
    const MEDICAL = 600, PASSIVE = 300;

    function runStreak(preds) {
      let streak = [];
      for (const atk of incoming) {
        const ts   = atkTs(atk);
        let prev   = null;
        for (let i = sortedLogs.length - 1; i >= 0; i--) {
          if (parseInt(sortedLogs[i].timestamp, 10) <= ts) { prev = sortedLogs[i]; break; }
        }
        const [, secs] = findLastActionBefore(sortedLogs, ts);
        if (prev && preds(prev, secs)) { streak.push(atk.id); }
        else {
          if (streak.length >= 3) streak.forEach(id => highlighted.add(id));
          streak = [];
        }
      }
      if (streak.length >= 3) streak.forEach(id => highlighted.add(id));
    }

    runStreak((p, s) => isMedical(p) && s !== null && s <= MEDICAL);
    runStreak((p, s) => isHospitalRelease(p) && !isMedical(p) && s !== null && s <= PASSIVE);
    return highlighted;
  }

  // ── Attack timestamp helper ─────────────────────────────────
  function atkTs(atk) {
    return parseInt(atk.ended ?? atk.started ?? atk.timestamp ?? 0, 10);
  }

  // ── Attacker stats ──────────────────────────────────────────
  function computeAttackerStats(incoming) {
    const map = {};
    for (const atk of incoming) {
      const att   = typeof atk.attacker === 'object' ? atk.attacker : {};
      const id    = String(att.id ?? atk.attacker_id ?? 'unknown');
      const name  = att.name ?? atk.attacker_name ?? '?';
      const resp  = parseFloat(atk.respect_gain ?? atk.respect ?? 0);
      if (!map[id]) map[id] = { id, name, count: 0, respect: 0 };
      map[id].count++;
      map[id].respect += resp;
    }
    return Object.values(map).sort((a, b) => b.count - a.count);
  }

  function computeHitByHour(incoming) {
    const hours = new Array(24).fill(0);
    for (const atk of incoming) {
      const ts = atkTs(atk);
      if (ts > 0) hours[new Date(ts * 1000).getUTCHours()]++;
    }
    return hours;
  }

  function computeOutgoingSessions(outgoing) {
    const sessions = [];
    let sessionN = 0, lastTs = null;
    const GAP = 1800;
    for (const atk of outgoing) {
      const ts = atkTs(atk);
      if (lastTs === null || (ts - lastTs) > GAP) sessionN++;
      sessions.push(sessionN);
      lastTs = ts;
    }
    return sessions;
  }

  function getPlayerStateAt(ts, timeline) {
    for (const h of timeline.hospital) { if (ts >= h.start && ts <= h.end) return 'Hospital'; }
    for (const t of timeline.travel)   { if (ts >= t.start && ts <= t.end) return 'Traveling'; }
    for (const a of timeline.active)   { if (ts >= a.start && ts <= a.end) return 'Active'; }
    return 'Idle';
  }

  // ── Timeline preparation ─────────────────────────────────────
  function prepareTimeline(outgoing, incoming, logs, warStart, warEnd) {
    const travel = [], hospital = [], activeTs = [];

    const incByTs = {};
    for (const atk of incoming) {
      const ts = atkTs(atk);
      (incByTs[ts] = incByTs[ts] || []).push(atk);
    }

    const fightLogByTs = {};
    for (const entry of logs) {
      const det = entry.details ?? {};
      const cat = typeof det === 'object' ? (det.category ?? '').toLowerCase() : '';
      const ttl = typeof det === 'object' ? (det.title ?? '').toLowerCase() : '';
      const ets = parseInt(entry.timestamp, 10);
      if (cat === 'attacking' && ttl.includes('receive')) {
        (fightLogByTs[ets] = fightLogByTs[ets] || []).push(ttl);
      }
    }

    for (const entry of logs) {
      const logTs = parseInt(entry.timestamp, 10);
      const det   = entry.details ?? {};
      const cat   = typeof det === 'object' ? (det.category ?? '').toLowerCase() : '';
      const title = typeof det === 'object' ? (det.title ?? '').toLowerCase() : '';
      const data  = entry.data ?? {};

      if (cat === 'travel' && title.includes('initiate')) {
        const dur  = parseInt(typeof data === 'object' ? (data.duration ?? 0) : 0, 10);
        const dest = parseInt(typeof data === 'object' ? (data.destination ?? 0) : 0, 10);
        const orig = parseInt(typeof data === 'object' ? (data.origin ?? 0) : 0, 10);
        if (dur > 0) {
          const end = logTs + dur;
          if (logTs <= warEnd && end >= warStart) {
            travel.push({ start: logTs, end, dest_id: dest, origin_id: orig, duration: dur });
          }
        }
        continue;
      }

      if (cat === 'hospital' && logTs >= warStart && logTs <= warEnd) {
        const dur    = parseInt(typeof data === 'object' ? (data.time ?? 0) : 0, 10);
        const reason = String(typeof data === 'object' ? (data.reason ?? '') : '');
        if (dur > 0) {
          let matched = null;
          for (let delta = -30; delta <= 30 && !matched; delta++) {
            const arr = incByTs[logTs + delta] ?? [];
            if (arr.length) matched = arr[0];
          }

          let type = null;
          for (let delta = -30; delta <= 30 && !type; delta++) {
            for (const fttl of (fightLogByTs[logTs + delta] ?? [])) {
              if (fttl.includes('leave'))  { type = 'leave';  break; }
              if (fttl.includes('mug') || fttl.includes('hosp') || fttl.includes('attack')) { type = 'attack'; break; }
            }
          }
          if (!type && matched) {
            const rl = (matched.result ?? '').toLowerCase();
            type = (rl.includes('leave') || rl.includes('left')) ? 'leave' : 'attack';
          }
          if (!type) {
            const rl = reason.toLowerCase();
            if (rl.includes('left') || rl.includes('leave') || rl.includes('street')) type = 'leave';
            else if (rl.includes('mug') || rl.includes('someone') || rl.includes('attack') || rl.includes('hospitali')) type = 'attack';
            else type = 'self';
          }

          let attName = null, attId = null;
          if (matched) {
            const att = typeof matched.attacker === 'object' ? matched.attacker : {};
            attName = att.name ?? matched.attacker_name ?? null;
            attId   = att.id   ?? matched.attacker_id   ?? null;
          }

          const hospEnd   = logTs + dur;
          const itemsUsed = [];
          for (const ie of logs) {
            const iets  = parseInt(ie.timestamp, 10);
            if (iets < logTs || iets > hospEnd) continue;
            const ied   = ie.details ?? {};
            const iecat = typeof ied === 'object' ? (ied.category ?? '').toLowerCase() : '';
            const iettl = typeof ied === 'object' ? (ied.title ?? '').toLowerCase() : '';
            if (iecat === 'item use' || iettl.includes('item use')) {
              const ied2 = ie.data ?? {};
              const n    = typeof ied2 === 'object' ? (ied2.item_name ?? ied2.item ?? iettl) : iettl;
              if (n) itemsUsed.push(String(n));
            }
          }

          hospital.push({
            start: logTs, end: hospEnd, type, duration: dur, reason,
            attacker: attName, attacker_id: attId,
            items_used: [...new Set(itemsUsed)],
          });
        }
        continue;
      }

      if (logTs >= warStart && logTs <= warEnd && cat !== 'travel' && cat !== 'hospital') {
        activeTs.push(logTs);
      }
    }

    // Prune active timestamps inside travel/hospital
    const pruned = activeTs.filter(ts => {
      return !travel.some(t  => ts >= t.start && ts <= t.end) &&
             !hospital.some(h => ts >= h.start && ts <= h.end);
    });

    const active = [];
    if (pruned.length) {
      pruned.sort((a, b) => a - b);
      const GAP = 1800, PAD = 300;
      let s = pruned[0], e = pruned[0];
      for (let i = 1; i < pruned.length; i++) {
        if (pruned[i] - e <= GAP) { e = pruned[i]; }
        else {
          active.push({ start: Math.max(warStart, s - PAD), end: Math.min(warEnd, e + PAD) });
          s = pruned[i]; e = pruned[i];
        }
      }
      active.push({ start: Math.max(warStart, s - PAD), end: Math.min(warEnd, e + PAD) });
    }

    return { travel, hospital, active };
  }

  // ── Dashboard stats ─────────────────────────────────────────
  function computeDashStats(outgoing, incoming, timeline, warStart, warEnd, accessLevel) {
    const warDur = Math.max(1, warEnd - warStart);

    let defendedSecs = 0;
    for (const t of timeline.travel) {
      const s = Math.max(t.start, warStart), e = Math.min(t.end, warEnd);
      if (e > s) defendedSecs += e - s;
    }
    for (const h of timeline.hospital) {
      if (h.type === 'self') {
        const s = Math.max(h.start, warStart), e = Math.min(h.end, warEnd);
        if (e > s) defendedSecs += e - s;
      }
    }

    // Bleeding: leave-hospital stays in sequences of ≥2 consecutive war attacks
    let bleedingSecs = 0;
    if (incoming.length) {
      const incTsIdx = {};
      for (const atk of incoming) { incTsIdx[atkTs(atk)] = true; }

      const sequences = [];
      let curSeq = [];
      for (const atk of incoming) {
        const ts = atkTs(atk);
        if (!curSeq.length) { curSeq.push(ts); continue; }
        const prevTs  = curSeq[curSeq.length - 1];
        let defended  = false;
        for (const t of timeline.travel) { if (t.start > prevTs && t.start < ts) { defended = true; break; } }
        if (!defended) {
          for (const h of timeline.hospital) {
            if (h.start <= prevTs || h.start >= ts) continue;
            if (h.type === 'self') { defended = true; break; }
            let nonwar = true;
            for (let d = -30; d <= 30 && nonwar; d++) { if (incTsIdx[h.start + d]) nonwar = false; }
            if (nonwar) { defended = true; break; }
          }
        }
        if (defended) { sequences.push(curSeq); curSeq = [ts]; }
        else curSeq.push(ts);
      }
      if (curSeq.length) sequences.push(curSeq);

      const qualifyingTs = {};
      for (const seq of sequences) {
        if (seq.length >= 2) seq.forEach(qt => { qualifyingTs[qt] = true; });
      }

      for (const h of timeline.hospital) {
        if (h.type !== 'leave') continue;
        let found = false;
        for (let d = -30; d <= 30 && !found; d++) { if (qualifyingTs[h.start + d]) found = true; }
        if (found) {
          const s = Math.max(h.start, warStart), e = Math.min(h.end, warEnd);
          if (e > s) bleedingSecs += e - s;
        }
      }
    }

    // Hitting: outgoing attack series
    let hittingSecs = 0;
    if (outgoing.length) {
      let serS = null, serE = null;
      for (const atk of outgoing) {
        const ts = atkTs(atk);
        if (serS === null) { serS = ts; serE = ts; continue; }
        let broken = (ts - serE) > 1800;
        if (!broken) for (const t of timeline.travel) { if (t.start > serE && t.start < ts) { broken = true; break; } }
        if (!broken) for (const h of timeline.hospital) {
          if (h.type === 'self' && h.start > serE && h.start < ts) { broken = true; break; }
        }
        if (broken) { hittingSecs += Math.max(0, serE - serS); serS = ts; serE = ts; }
        else serE = ts;
      }
      if (serS !== null) hittingSecs += Math.max(0, serE - serS);
    }

    // Avg recovery
    const recoveryTimes = [];
    if (accessLevel === 'full') {
      for (const h of timeline.hospital) {
        if (h.type !== 'self') {
          const hospEnd = h.end;
          for (const atk of outgoing) {
            const ts = atkTs(atk);
            if (ts > hospEnd) { recoveryTimes.push(ts - hospEnd); break; }
          }
        }
      }
    }
    const avgRecovery = recoveryTimes.length
      ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length)
      : null;

    // Active vulnerability
    let hitsDuringActive = 0;
    if (accessLevel === 'full') {
      for (const atk of incoming) {
        if (getPlayerStateAt(atkTs(atk), timeline) === 'Active') hitsDuringActive++;
      }
    }

    return {
      warDur, defendedSecs, bleedingSecs, hittingSecs, avgRecovery, hitsDuringActive,
      defPct:  +(defendedSecs / warDur * 100).toFixed(1),
      bldPct:  +(bleedingSecs / warDur * 100).toFixed(1),
      hitPct:  +(hittingSecs  / warDur * 100).toFixed(1),
      vulnPct: incoming.length ? +(hitsDuringActive / incoming.length * 100).toFixed(1) : 0,
    };
  }

  // ── HTML report builder ──────────────────────────────────────
  function buildReport(outgoing, incoming, logs, warStart, warEnd, oppName, oppId, warResult, accessLevel) {
    const sortedLogs = [...logs].sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10));
    const badIds     = accessLevel === 'full' ? analyzeBehavior(incoming, sortedLogs) : new Set();

    const repWon  = outgoing.reduce((s, a) => s + parseFloat(a.respect_gain ?? a.respect ?? 0), 0);
    const repLost = incoming.reduce((s, a) => s + parseFloat(a.respect_gain ?? a.respect ?? 0), 0);
    const netRep  = repWon - repLost;
    const netCls  = netRep > 0 ? 'green' : netRep < 0 ? 'red' : 'yellow';
    const res     = warResult.result ?? 'Unknown';
    const resCls  = res === 'Won' ? 'green' : res === 'Lost' ? 'red' : 'yellow';

    const timeline         = (accessLevel === 'full' && logs.length)
      ? prepareTimeline(outgoing, incoming, logs, warStart, warEnd)
      : { travel: [], hospital: [], active: [] };

    const attackerStats    = computeAttackerStats(incoming);
    const hitByHour        = computeHitByHour(incoming);
    const hitCountById     = Object.fromEntries(attackerStats.map(s => [s.id, s.count]));
    const outgoingSessions = computeOutgoingSessions(outgoing);
    const dash             = computeDashStats(outgoing, incoming, timeline, warStart, warEnd, accessLevel);
    const avgRespAtk       = outgoing.length ? repWon / outgoing.length : 0;

    // Timeline JSON for JS
    const tlOut = outgoing.map(a => {
      const dfn = typeof a.defender === 'object' ? a.defender : {};
      return { ts: atkTs(a), respect: parseFloat(a.respect_gain ?? a.respect ?? 0), opponent: dfn.name ?? a.defender_name ?? '?' };
    });
    const tlInc = incoming.map(a => {
      const att = typeof a.attacker === 'object' ? a.attacker : {};
      return { ts: atkTs(a), respect: parseFloat(a.respect_gain ?? a.respect ?? 0), attacker: att.name ?? a.attacker_name ?? '?' };
    });
    const tlJson  = JSON.stringify({ warStart, warEnd, travel: timeline.travel, hospital: timeline.hospital, active: timeline.active, outgoing: tlOut, incoming: tlInc });
    const aaJson  = JSON.stringify({ hitByHour, attackerList: attackerStats.slice(0, 20).map(s => ({ id: s.id, name: s.name, count: s.count, respect: +s.respect.toFixed(2) })) });

    const DEST = { 1:'Torn',2:'Cayman Islands',3:'UK',4:'Argentina',5:'Switzerland',6:'Japan',7:'China',8:'UAE',9:'Canada',10:'Hawaii',11:'Mexico',12:'South Africa' };

    // ── Build HTML string ──
    let H = `
<div id="pwrt-close-btn" style="position:absolute;top:12px;right:16px;cursor:pointer;font-size:22px;color:#aaa;z-index:10" title="Close">✕</div>
<div class="pwrt-header">
  <h1>⚔ Personal War Report – TORN</h1>
  <p style="color:#aaa;font-size:11px;margin:0 0 4px">Generated: ${new Date().toLocaleString()}</p>
  <div class="summary">
    <div class="sb"><div class="lbl">Opponent</div><div class="val">${esc(oppName ?? '?')}${oppId ? `<div style="font-size:11px;color:#aaa;font-weight:normal;margin-top:2px">ID ${esc(oppId)}</div>` : ''}</div></div>
    <div class="sb"><div class="lbl">War Period</div><div class="val" style="font-size:12px;line-height:1.5">${esc(fmtTs(warStart))}<br>→ ${esc(fmtTs(warEnd))}</div></div>
    <div class="sb"><div class="lbl">Result</div><div class="val ${resCls}">${esc(res)}</div></div>
    ${warResult.ownScore != null ? `<div class="sb"><div class="lbl">Score</div><div class="val">${esc(warResult.ownScore)} – ${esc(warResult.oppScore)}</div></div>` : ''}
    <div class="sb"><div class="lbl">Respect Won</div><div class="val rw">+${nf(repWon)}</div></div>
    <div class="sb"><div class="lbl">Respect Lost</div><div class="val rl">-${nf(repLost)}</div></div>
    <div class="sb-net"><div class="lbl">Net Respect</div><div class="val ${netCls}">${netRep >= 0 ? '+' : ''}${nf(netRep)}</div></div>
  </div>
</div>
<div class="pwrt-body">
  <div class="tab-nav">
    <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
    <button class="tab-btn" data-tab="fights">Fight Details</button>
    <button class="tab-btn" data-tab="attackers">Attacker Analysis</button>
    <button class="tab-btn" data-tab="heatmap">Activity Heatmap</button>
  </div>

  <!-- TAB: Dashboard -->
  <div id="pwrt-tab-dashboard" class="tab-pane active">
    <h2>Dashboard</h2>
    <div class="tl-legend">
      <span class="leg-item"><span class="leg-dot" style="background:#3aaa55"></span> Active play</span>
      <span class="leg-item"><span class="leg-dot" style="background:#5bc8f5"></span> In the air</span>
      <span class="leg-item"><span class="leg-dot" style="background:#9955cc"></span> Hospital (other)</span>
      <span class="leg-item"><span class="leg-dot" style="background:#ff8833"></span> Hospital (attack)</span>
      <span class="leg-item"><span class="leg-dot" style="background:#ff3333"></span> Hospital (leave)</span>
      <span class="leg-item"><span class="leg-dot" style="background:#dd4444"></span> Incoming ←</span>
      <span class="leg-item"><span class="leg-dot" style="background:#44cc66"></span> Outgoing →</span>
    </div>
    ${accessLevel !== 'full' ? '<p class="tl-no-data">Activity bands require Full Access API key. Showing attack bars only.</p>' : ''}
    <div class="vtl-outer">
      <div class="vtl-header">
        <div class="vtl-left-lbl">← Incoming (respect lost)</div>
        <div class="vtl-center-lbl">War timeline</div>
        <div class="vtl-right-lbl">Outgoing (respect gained) →</div>
      </div>
      <div class="vtl-body">
        <div id="pwrt-vtl-left"  class="vtl-left"></div>
        <div class="vtl-center-col">
          <div id="pwrt-vtl-track" class="vtl-track"></div>
          <div id="pwrt-vtl-axis"  class="vtl-axis"></div>
        </div>
        <div id="pwrt-vtl-right" class="vtl-right"></div>
      </div>
    </div>
    <div class="dash-stats">
      <div class="ds ds-blue"><div class="ds-lbl">Time defended</div><div class="ds-pct">${dash.defPct} %</div><div class="ds-abs">${fmtDur(dash.defendedSecs)}</div></div>
      <div class="ds ds-red"><div class="ds-lbl">Time bleeding</div><div class="ds-pct">${dash.bldPct} %</div><div class="ds-abs">${fmtDur(dash.bleedingSecs)}</div></div>
      <div class="ds ds-green"><div class="ds-lbl">Time hitting</div><div class="ds-pct">${dash.hitPct} %</div><div class="ds-abs">${fmtDur(dash.hittingSecs)}</div></div>
      <div class="ds ds-orange">
        <div class="ds-lbl">Ø Recovery Time</div>
        ${accessLevel === 'full' && dash.avgRecovery != null
          ? `<div class="ds-pct" style="font-size:18px">${fmtDur(dash.avgRecovery)}</div><div class="ds-abs">Hosp. → next attack</div>`
          : `<div class="ds-pct" style="font-size:18px;color:#445">–</div><div class="ds-abs">${accessLevel !== 'full' ? 'Full Access required' : 'No combat hospital'}</div>`}
      </div>
      <div class="ds ds-blue"><div class="ds-lbl">Ø Respect / Attack</div><div class="ds-pct" style="font-size:18px">${nf(avgRespAtk)}</div><div class="ds-abs">${outgoing.length} attacks total</div></div>
      ${accessLevel === 'full'
        ? `<div class="ds ${dash.vulnPct >= 50 ? 'ds-red' : 'ds-orange'}"><div class="ds-lbl">Active Vulnerability</div><div class="ds-pct">${dash.vulnPct} %</div><div class="ds-abs">${dash.hitsDuringActive} / ${incoming.length} hits in active window</div></div>`
        : ''}
    </div>
  </div>

  <!-- TAB: Fight Details -->
  <div id="pwrt-tab-fights" class="tab-pane">
    <div class="columns">
      <div class="col col-left">
        <h2>Outgoing Attacks</h2>
        <div class="slbl">${outgoing.length} attacks &nbsp;|&nbsp; +${nf(repWon)} respect</div>
        <table><thead><tr><th style="color:#778">S.</th><th>Time</th><th>Opponent</th><th>Respect</th><th>Log</th></tr></thead><tbody>
        ${outgoing.map((atk, idx) => {
          const ts      = atkTs(atk);
          const code    = atk.code ?? '';
          const dfn     = typeof atk.defender === 'object' ? atk.defender : {};
          const defName = esc(dfn.name ?? atk.defender_name ?? '?');
          const defId   = dfn.id ?? atk.defender_id ?? '';
          const rep     = parseFloat(atk.respect_gain ?? atk.respect ?? 0);
          const repCls  = rep > 0 ? 'rw' : 'rl';
          const rowCls  = rep > 0 ? '' : ' class="bg-orange"';
          const logLink = code ? `<a href="https://www.torn.com/page.php?sid=attackLog&ID=${esc(code)}" target="_blank">↗</a>` : '';
          const prof    = defId ? `<a href="https://www.torn.com/profiles.php?XID=${esc(defId)}" target="_blank">${defName}</a>` : defName;
          return `<tr${rowCls}><td style="color:#778;font-size:11px;text-align:center">${outgoingSessions[idx] ?? ''}</td><td class="ts">${esc(fmtTs(ts))}</td><td>${prof}</td><td class="${repCls}">+${nf(rep)}</td><td>${logLink}</td></tr>`;
        }).join('')}
        </tbody></table>
      </div>
      <div class="col col-right">
        <h2>Incoming Attacks</h2>
        <div class="slbl">${incoming.length} attacks &nbsp;|&nbsp; -${nf(repLost)} respect</div>
        <table><thead><tr>
          <th style="color:#778">#</th><th>Time</th><th>Attacker</th><th>Respect</th>
          ${accessLevel === 'full' ? '<th>State</th><th>Last Action</th><th>Before hit</th>' : ''}
          <th>Log</th>
        </tr></thead><tbody>
        ${incoming.map(atk => {
          const ts      = atkTs(atk);
          const code    = atk.code ?? '';
          const att     = typeof atk.attacker === 'object' ? atk.attacker : {};
          const attName = esc(att.name ?? atk.attacker_name ?? '?');
          const attId   = att.id ?? atk.attacker_id ?? '';
          const rep     = parseFloat(atk.respect_gain ?? atk.respect ?? 0);
          const atkId   = atk.id;
          const rowCls  = badIds.has(atkId) ? ' class="bg-red"' : '';
          const logLink = code ? `<a href="https://www.torn.com/page.php?sid=attackLog&ID=${esc(code)}" target="_blank">↗</a>` : '';
          const prof    = attId ? `<a href="https://www.torn.com/profiles.php?XID=${esc(attId)}" target="_blank">${attName}</a>` : attName;
          const hc      = hitCountById[String(attId)] ?? 1;
          const hcCss   = hc >= 5 ? 'color:#ff4444;font-weight:bold' : hc >= 3 ? 'color:#ff8833;font-weight:bold' : 'color:#aaa';
          const badge   = `<span style="${hcCss}">${hc}×</span>`;

          if (accessLevel === 'full') {
            const [lastAction, secsBefore] = findLastActionBefore(sortedLogs, ts);
            let actionCell = esc(lastAction);
            if (lastAction.toLowerCase().includes('travel')) {
              actionCell += '<br><span style="color:#cc99ff;font-size:13px">⏰ Bad timing in returning. Set alarm clock!</span>';
            }
            const [notable, notableSecs] = findNotableEventBefore(sortedLogs, ts);
            if (notable) {
              const nd    = notable.details ?? {};
              const nlbl  = typeof nd === 'object' ? (nd.title ?? nd.category ?? 'Notable event') : 'Notable event';
              const nts   = parseInt(notable.timestamp, 10);
              const [oc, or_] = countOutgoingInWindow(outgoing, nts, ts);
              let extra   = `<br><span style="color:#cc99ff;font-size:13px">↳ ${esc(nlbl)} ${fmtDur(notableSecs)} before`;
              if (oc > 0) extra += ` &nbsp;|&nbsp; ${oc} outgoing attack${oc !== 1 ? 's' : ''}, +${nf(or_)} respect`;
              extra += '</span>';
              actionCell += extra;
            }
            const state   = getPlayerStateAt(ts, timeline);
            const stCell  = state === 'Active' ? '<span style="color:#44cc66">Active</span>'
                          : state === 'Hospital' ? '<span style="color:#ff8833">Hospital</span>'
                          : state === 'Traveling' ? '<span style="color:#5bc8f5">✈ Traveling</span>'
                          : '<span style="color:#778">Idle</span>';
            return `<tr${rowCls}><td style="text-align:center">${badge}</td><td class="ts">${esc(fmtTs(ts))}</td><td>${prof}</td><td class="rl">-${nf(rep)}</td><td>${stCell}</td><td class="ac">${actionCell}</td><td class="tc">${fmtDur(secsBefore)}</td><td>${logLink}</td></tr>`;
          }
          return `<tr${rowCls}><td style="text-align:center">${badge}</td><td class="ts">${esc(fmtTs(ts))}</td><td>${prof}</td><td class="rl">-${nf(rep)}</td><td>${logLink}</td></tr>`;
        }).join('')}
        </tbody></table>
        ${accessLevel === 'full' && badIds.size ? '<p style="margin-top:10px;color:#ff8888;font-size:12px">⚠ Red rows indicate potential misbehavior: repeated medical item use or passive hospital releases immediately followed by enemy attacks (≥3 times in a row).</p>' : ''}
      </div>
    </div>
  </div>

  <!-- TAB: Attacker Analysis -->
  <div id="pwrt-tab-attackers" class="tab-pane">
    <h2>Attacker Analysis</h2>
    <div class="aa-grid">
      <div class="aa-col" style="flex:0 0 auto;min-width:260px">
        <h3 style="color:#aaddff;font-size:14px;margin-bottom:10px">Top Attackers</h3>
        ${!incoming.length ? '<p style="color:#556;font-style:italic">No incoming attacks in this war.</p>' : `
        <table><thead><tr><th>#</th><th>Attacker</th><th>Hits</th><th>Respect Lost</th></tr></thead><tbody>
        ${attackerStats.map((s, rank) => {
          const nameCell = (s.id !== 'unknown' && s.id !== '')
            ? `<a href="https://www.torn.com/profiles.php?XID=${esc(s.id)}" target="_blank">${esc(s.name)}</a>`
            : esc(s.name);
          const cntCss = s.count >= 5 ? 'color:#ff4444;font-weight:bold' : s.count >= 3 ? 'color:#ff8833;font-weight:bold' : 'color:#aaa';
          const rowBg  = s.count >= 3 ? ' style="background:#2a1010"' : '';
          return `<tr${rowBg}><td style="color:#556">${rank + 1}.</td><td>${nameCell}</td><td style="${cntCss}">${s.count}×</td><td class="rl">-${nf(s.respect)}</td></tr>`;
        }).join('')}
        </tbody></table>`}
      </div>
      <div class="aa-col" style="flex:1;min-width:280px">
        <h3 style="color:#aaddff;font-size:14px;margin-bottom:10px">Incoming Hit Distribution by Hour (UTC)</h3>
        ${!incoming.length ? '<p style="color:#556;font-style:italic">No incoming attacks.</p>' : `
        <p style="color:#778;font-size:11px;margin-bottom:8px">Each bar = one UTC hour. Red bars = most frequent attack windows (Top 3).</p>
        <div class="hour-chart-wrap">
          <div id="pwrt-hour-chart" class="hour-chart"></div>
          <div id="pwrt-hour-axis"  class="hour-axis"></div>
        </div>
        <div id="pwrt-hour-peak" style="font-size:12px;color:#aaa;margin-top:10px"></div>`}
      </div>
    </div>
  </div>

  <!-- TAB: Activity Heatmap -->
  <div id="pwrt-tab-heatmap" class="tab-pane">
    <h2>Activity Heatmap</h2>
    <p style="color:#aaa;font-size:12px;margin-bottom:16px">Attack distribution by war day and hour (UTC). Deeper color = more attacks.</p>
    <div id="pwrt-heatmap"></div>
  </div>

</div>
<div id="pwrt-tl-tooltip" class="tl-tooltip"></div>
<script>
(function(){
  var TL = ${tlJson};
  var AA = ${aaJson};
  var wS = TL.warStart, wE = TL.warEnd, dur = wE - wS;
  var DEST = {1:'Torn',2:'Cayman Islands',3:'UK',4:'Argentina',5:'Switzerland',6:'Japan',7:'China',8:'UAE',9:'Canada',10:'Hawaii',11:'Mexico',12:'South Africa'};
  function fDur(s){ if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m '+(s%60)+'s'; var h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h+'h'+(m?' '+m+'m':''); }
  function fUtc(ts){ var d=new Date(ts*1000); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0')+' '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' UTC'; }
  function fHour(ts){ var d=new Date(ts*1000); return String(d.getUTCHours()).padStart(2,'0')+':00'; }
  function tickIv(t){ var iv=[3600,7200,14400,21600,43200,86400]; for(var i=0;i<iv.length;i++) if(t/iv[i]<=12) return iv[i]; return 86400; }

  var tip=document.getElementById('pwrt-tl-tooltip');
  document.addEventListener('mousemove',function(e){ if(tip.style.display!=='none'){ var x=e.clientX+14,y=e.clientY-12; if(x+310>window.innerWidth) x=e.clientX-316; tip.style.left=x+'px'; tip.style.top=y+'px'; } });
  function addTip(el,html){ el.addEventListener('mouseenter',function(){ tip.innerHTML=html; tip.style.display='block'; }); el.addEventListener('mouseleave',function(){ tip.style.display='none'; }); }

  function render(){
    var trackEl=document.getElementById('pwrt-vtl-track');
    var leftEl=document.getElementById('pwrt-vtl-left');
    var rightEl=document.getElementById('pwrt-vtl-right');
    var axisEl=document.getElementById('pwrt-vtl-axis');
    if(!trackEl) return;
    trackEl.innerHTML=''; leftEl.innerHTML=''; rightEl.innerHTML=''; axisEl.innerHTML='';
    // Dynamic height: ~1 px per 4 min of war, min 400 px, max 2000 px
    var tlH=Math.max(400,Math.min(2000,Math.round(dur/240)));
    var body=document.querySelector('.vtl-body'); if(body) body.style.height=tlH+'px';
    function vpct(ts){ return Math.max(0,Math.min(100,(ts-wS)/dur*100)); }
    function mkSeg(tp,hp,color,tipHtml){
      var el=document.createElement('div'); el.className='vtl-seg';
      el.style.top=tp+'%'; el.style.height=Math.max(hp,0.2)+'%'; el.style.background=color;
      if(tipHtml) addTip(el,tipHtml); return el;
    }
    TL.active.forEach(function(a){ var tp=vpct(a.start),hp=vpct(a.end)-tp; trackEl.appendChild(mkSeg(tp,hp,'#3aaa55','<b>Active play</b><br>'+fUtc(a.start)+' – '+fUtc(a.end))); });
    TL.travel.forEach(function(t){ var d=DEST[t.dest_id]||('Location #'+t.dest_id),o=DEST[t.origin_id]||('Location #'+t.origin_id),tp=vpct(t.start),hp=vpct(t.end)-tp; trackEl.appendChild(mkSeg(tp,hp,'#5bc8f5','<b>✈ '+o+' → '+d+'</b><br>Duration: '+fDur(t.duration)+'<br>'+fUtc(t.start))); });
    TL.hospital.forEach(function(h){ var tp=vpct(h.start),hp=vpct(h.end)-tp,color=h.type==='leave'?'#ff3333':h.type==='attack'?'#ff8833':'#9955cc',title=h.type==='leave'?'🏥 Hospital <em>(leave)</em>':h.type==='attack'?'🏥 Hospital <em>(attack)</em>':'🏥 Hospital <em>(other)</em>'; var th='<b>'+title+'</b><br>Duration: '+fDur(h.duration)+'<br>'+fUtc(h.start); if(h.attacker) th+='<br>By: '+h.attacker; if(h.items_used&&h.items_used.length) th+='<br>Items: '+h.items_used.join(', '); trackEl.appendChild(mkSeg(tp,hp,color,th)); });
    var allRe=TL.outgoing.map(function(a){return a.respect;}).concat(TL.incoming.map(function(a){return a.respect;})),maxRe=Math.max.apply(null,allRe.concat([0.01]));
    // Incoming → LEFT column, bar extends from right edge leftward (respect lost)
    TL.incoming.forEach(function(a){
      var bw=Math.max(a.respect/maxRe*95,1),bar=document.createElement('div');
      bar.className='vtl-bar-in'; bar.style.top=vpct(a.ts)+'%'; bar.style.width=bw+'%';
      addTip(bar,'<b>💥 Incoming</b><br>Attacker: '+a.attacker+'<br><span style="color:#ff6666">-'+a.respect.toFixed(2)+' respect</span><br>'+fUtc(a.ts));
      leftEl.appendChild(bar);
    });
    // Outgoing → RIGHT column, bar extends from left edge rightward (respect gained)
    TL.outgoing.forEach(function(a){
      var bw=Math.max(a.respect/maxRe*95,1),bar=document.createElement('div');
      bar.className='vtl-bar-out'; bar.style.top=vpct(a.ts)+'%'; bar.style.width=bw+'%';
      addTip(bar,'<b>⚔ Outgoing</b><br>Opponent: '+a.opponent+'<br><span style="color:#66dd88">+'+a.respect.toFixed(2)+' respect</span><br>'+fUtc(a.ts));
      rightEl.appendChild(bar);
    });
    // Hour ticks on axis column
    var iv=tickIv(dur),fh2=Math.ceil(wS/3600)*3600;
    for(var ts=fh2;ts<=wE;ts+=iv){ if(ts<wS) continue; var tk=document.createElement('div'); tk.className='vtl-tick'; tk.style.top=vpct(ts)+'%'; tk.textContent=fHour(ts); axisEl.appendChild(tk); }
    // Day labels on axis column
    var dStart2=Math.floor(wS/86400)*86400;
    for(var dts=dStart2;dts<=wE;dts+=86400){
      var segS=Math.max(dts,wS),segE=Math.min(dts+86400,wE); if(segE<=segS) continue;
      var midVp=(vpct(segS)+vpct(segE))/2,dd2=new Date(dts*1000),dl=document.createElement('div');
      dl.className='vtl-date-label'; dl.style.top=midVp+'%';
      dl.textContent=String(dd2.getUTCDate()).padStart(2,'0')+'.'+String(dd2.getUTCMonth()+1).padStart(2,'0')+'.'+dd2.getUTCFullYear();
      axisEl.appendChild(dl);
    }
  }

  function renderHourChart(){
    var chartEl=document.getElementById('pwrt-hour-chart'),axisEl=document.getElementById('pwrt-hour-axis'),peakEl=document.getElementById('pwrt-hour-peak');
    if(!chartEl||!AA) return;
    var hours=AA.hitByHour,maxH=Math.max.apply(null,hours.concat([1]));
    chartEl.innerHTML=''; axisEl.innerHTML='';
    var ranked=hours.map(function(c,h){return{h,c};}).filter(function(x){return x.c>0;}).sort(function(a,b){return b.c-a.c;});
    var danger={}; ranked.slice(0,3).forEach(function(x){danger[x.h]=true;});
    hours.forEach(function(cnt,h){ var frac=cnt/maxH,bh=cnt>0?Math.max(4,Math.round(frac*96)):2,bar=document.createElement('div'); bar.className='hour-bar'; bar.style.height=bh+'px'; bar.style.background=cnt===0?'#2a2a3a':danger[h]?'#ff3333':'#cc4444'; if(cnt>0){var hh=String(h).padStart(2,'0'); addTip(bar,'<b>🕐 '+hh+':00–'+hh+':59 UTC</b><br><span style="color:#ff8888">'+cnt+' incoming hit'+(cnt!==1?'s':'')+'</span>'+(danger[h]?'<br><span style="color:#ff4444">⚠ Danger hour</span>':''));} chartEl.appendChild(bar); var lbl=document.createElement('div'); lbl.className='hour-lbl'+(h%6===0?' show':''); lbl.textContent=h%6===0?String(h).padStart(2,'0'):''; axisEl.appendChild(lbl); });
    if(peakEl&&ranked.length>0) peakEl.innerHTML='⚠ Peak attack hours: <span style="color:#ff6666;font-weight:bold">'+ranked.slice(0,3).map(function(x){return String(x.h).padStart(2,'0')+':00 UTC ('+x.c+'×)';}).join(' &nbsp;·&nbsp; ')+'</span>';
  }

  function renderHeatmap(){
    var container=document.getElementById('pwrt-heatmap'); if(!container) return; container.innerHTML='';
    var dayStart=Math.floor(TL.warStart/86400)*86400,dayCount=Math.ceil((TL.warEnd-dayStart)/86400);
    var inc2D=[],out2D=[];
    for(var d=0;d<dayCount;d++){inc2D.push(new Array(24).fill(0));out2D.push(new Array(24).fill(0));}
    TL.incoming.forEach(function(a){var d=Math.floor((a.ts-dayStart)/86400),h=Math.floor(((a.ts%86400)+86400)%86400/3600);if(d>=0&&d<dayCount)inc2D[d][h]++;});
    TL.outgoing.forEach(function(a){var d=Math.floor((a.ts-dayStart)/86400),h=Math.floor(((a.ts%86400)+86400)%86400/3600);if(d>=0&&d<dayCount)out2D[d][h]++;});
    function makeGrid(data,cr,cg,cb,title){
      var maxVal=1; data.forEach(function(r){r.forEach(function(v){if(v>maxVal)maxVal=v;});});
      var sec=document.createElement('div'); sec.style.marginBottom='28px';
      var h3=document.createElement('h3'); h3.style.cssText='color:#aaddff;font-size:14px;margin-bottom:10px'; h3.textContent=title; sec.appendChild(h3);
      var grid=document.createElement('div'); grid.style.cssText='display:grid;grid-template-columns:44px repeat(24,1fr);gap:2px'; grid.appendChild(document.createElement('div'));
      for(var h=0;h<24;h++){var cl=document.createElement('div');cl.style.cssText='font-size:9px;color:#556;text-align:center;padding-bottom:2px';cl.textContent=h%6===0?String(h).padStart(2,'0'):'';grid.appendChild(cl);}
      data.forEach(function(row,d){var dd=new Date((dayStart+d*86400)*1000),rl=document.createElement('div');rl.style.cssText='font-size:11px;color:#778;text-align:right;padding-right:4px;line-height:20px';rl.textContent=String(dd.getUTCDate()).padStart(2,'0')+'.'+String(dd.getUTCMonth()+1).padStart(2,'0')+'.';grid.appendChild(rl);row.forEach(function(cnt,h){var cell=document.createElement('div');cell.style.cssText='height:20px;border-radius:2px;cursor:default';if(cnt===0){cell.style.background='#1e1e2e';}else{var alpha=Math.min(1,Math.max(0.15,cnt/maxVal));cell.style.background='rgba('+cr+','+cg+','+cb+','+alpha+')';}if(cnt>0)addTip(cell,String(h).padStart(2,'0')+':00 UTC – '+String(dd.getUTCDate()).padStart(2,'0')+'.'+String(dd.getUTCMonth()+1).padStart(2,'0')+'.'+dd.getUTCFullYear()+'<br>'+cnt+' attack'+(cnt!==1?'s':''));grid.appendChild(cell);});});
      sec.appendChild(grid); container.appendChild(sec);
    }
    makeGrid(inc2D,221,68,68,'⬇ Incoming Attacks (per Day & Hour)');
    makeGrid(out2D,68,204,102,'⬆ Outgoing Attacks (per Day & Hour)');
  }

  render(); renderHourChart(); renderHeatmap(); window.addEventListener('resize',render);
  document.querySelectorAll('#pwrt-overlay .tab-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var tab=this.dataset.tab;
      document.querySelectorAll('#pwrt-overlay .tab-btn').forEach(function(b){b.classList.remove('active');});
      document.querySelectorAll('#pwrt-overlay .tab-pane').forEach(function(p){p.classList.remove('active');});
      this.classList.add('active');
      document.getElementById('pwrt-tab-'+tab).classList.add('active');
    });
  });
  var closeBtn=document.getElementById('pwrt-close-btn');
  if(closeBtn) closeBtn.addEventListener('click',function(){ var ov=document.getElementById('pwrt-overlay'); if(ov) ov.style.display='none'; });
}());
</script>`;

    return H;
  }

  // ── Orchestration ────────────────────────────────────────────
  async function runReport(key, dateStr, onStatus) {
    onStatus('Checking API key…');
    const [accessLevel, keyErr] = await checkKeyPermissions(key);
    if (keyErr) throw new Error(keyErr);

    onStatus('Fetching player info…');
    const [playerId, factionId] = await getPlayerInfo(key);
    if (!playerId) throw new Error('Could not retrieve player ID from API. Check your key.');
    if (!factionId) throw new Error('Could not retrieve faction ID. Are you in a faction?');

    const searchTs = parseDateStr(dateStr);
    onStatus('Scanning events for war start…');
    const [warStart, oppId, oppName] = await getWarStartAndOpponent(searchTs, factionId, key);
    if (!warStart) throw new Error(`No ranked-war start event found on or before ${dateStr}. Enter a date during or just after the war.`);

    onStatus('Fetching war end, result and attacks…');
    const [warEnd, warResult, allAttacks] = await Promise.all([
      findWarEnd(warStart, key),
      getWarResult(warStart, oppId, key),
      getAttacksV2(warStart, warStart + 123 * 3600 + 3600, key),
    ]);

    onStatus(`Filtering ${allAttacks.length} attacks…`);

    const outgoing = [], incoming = [];
    for (const atk of allAttacks) {
      const rw = atk.is_ranked_war ?? atk.ranked_war ?? atk.modifiers?.ranked_war ?? false;
      if (!rw) continue;
      const att   = typeof atk.attacker === 'object' ? atk.attacker : {};
      const dfn   = typeof atk.defender === 'object' ? atk.defender : {};
      const attId = att.id ?? atk.attacker_id;
      const dfnId = dfn.id ?? atk.defender_id;
      if (String(attId) === String(playerId)) outgoing.push(atk);
      else if (String(dfnId) === String(playerId)) incoming.push(atk);
    }

    const sortFn = (a, b) => atkTs(a) - atkTs(b);
    outgoing.sort(sortFn);
    incoming.sort(sortFn);

    // Fallback opponent name
    let resolvedOppName = oppName;
    if (!resolvedOppName) {
      outer: for (const atk of [...outgoing, ...incoming]) {
        for (const side of [atk.attacker, atk.defender]) {
          if (typeof side !== 'object') continue;
          const fac = side.faction;
          if (typeof fac === 'object' && String(fac.id) === String(oppId) && fac.name) {
            resolvedOppName = fac.name;
            break outer;
          }
        }
      }
    }

    let logs = [];
    if (accessLevel === 'full') {
      onStatus('Fetching activity logs…');
      logs = await getLogsV2(warStart, warEnd, key);
    }

    onStatus('Rendering report…');
    return buildReport(outgoing, incoming, logs, warStart, warEnd, resolvedOppName, oppId, warResult, accessLevel);
  }

  // ── CSS ───────────────────────────────────────────────────────
  const CSS = `
@keyframes pwrt-spin{to{transform:rotate(360deg)}}
#pwrt-trigger-bar {
  background:#252545;border-bottom:2px solid #3355aa;padding:8px 16px;
  font-family:Arial,sans-serif;font-size:13px;color:#e0e0e0;position:relative;z-index:100;
}
#pwrt-bar-toggle {
  display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;padding:2px 0;
}
#pwrt-bar-toggle h3 { color:#e0c060;margin:0;font-size:15px;font-weight:bold;letter-spacing:.5px; }
#pwrt-toggle-arrow {
  font-size:11px;color:#5577cc;transition:transform .25s ease;display:inline-block;
}
#pwrt-trigger-bar.pwrt-expanded #pwrt-toggle-arrow { transform:rotate(180deg); }
#pwrt-bar-content {
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  overflow:hidden;max-height:0;transition:max-height .3s ease,padding-top .3s ease;padding-top:0;
}
#pwrt-trigger-bar.pwrt-expanded #pwrt-bar-content { max-height:200px;padding-top:8px; }
#pwrt-key-input {
  padding:6px 10px;background:#12122a;border:1px solid #334;border-radius:4px;
  color:#e0e0e0;font-size:13px;width:240px;outline:none;
}
#pwrt-key-input:focus { border-color:#5577cc; }
#pwrt-date-input {
  padding:6px 10px;background:#12122a;border:1px solid #334;border-radius:4px;
  color:#e0e0e0;font-size:13px;width:110px;outline:none;
}
#pwrt-date-input:focus { border-color:#5577cc; }
.pwrt-btn {
  padding:6px 16px;background:#3355aa;border:none;border-radius:4px;
  color:#fff;font-size:13px;font-weight:bold;cursor:pointer;transition:background .2s;
}
.pwrt-btn:hover { background:#4466cc; }
.pwrt-btn:disabled { background:#2a2a4a;color:#556;cursor:not-allowed; }
#pwrt-save-key {
  padding:6px 12px;background:#224422;border:1px solid #336633;border-radius:4px;
  color:#88dd88;font-size:12px;cursor:pointer;
}
#pwrt-save-key:hover { background:#2a5522; }
#pwrt-status { color:#aaa;font-size:12px;font-style:italic; }
#pwrt-err-msg { color:#ff8888;font-size:12px;max-width:400px; }

/* Overlay */
#pwrt-overlay {
  display:none;position:fixed;inset:0;z-index:99999;
  background:#1a1a2e;overflow-y:auto;font-family:Arial,sans-serif;font-size:13px;color:#e0e0e0;
}
#pwrt-overlay.active { display:block; }

/* Report styles */
#pwrt-overlay *{box-sizing:border-box}
#pwrt-overlay h1{color:#e0c060;margin:0 0 2px}
#pwrt-overlay h2{color:#aaddff;border-bottom:1px solid #334;padding-bottom:4px;margin-top:20px;margin-bottom:12px}
.pwrt-header{position:sticky;top:0;z-index:50;background:#1a1a2e;border-bottom:2px solid #334455;padding:10px 16px 8px}
.pwrt-body{padding:0 16px 24px}
.summary{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 4px}
.sb{background:#252545;border-radius:6px;padding:8px 16px;min-width:110px}
.sb .lbl{font-size:11px;color:#aaa;text-transform:uppercase}
.sb .val{font-size:20px;font-weight:bold;margin-top:2px}
.sb-net{background:#303060;border-radius:6px;padding:8px 16px;min-width:110px}
.sb-net .lbl{font-size:11px;color:#aaa;text-transform:uppercase}
.sb-net .val{font-size:20px;font-weight:bold;margin-top:2px}
.green{color:#66dd88}.red{color:#ff6666}.yellow{color:#ffcc44}
.tab-nav{display:flex;gap:2px;border-bottom:2px solid #334;margin-bottom:16px;margin-top:12px}
.tab-btn{padding:8px 24px;background:#252545;color:#aaa;border:1px solid #334;border-bottom:none;border-radius:4px 4px 0 0;cursor:pointer;font-size:13px;transition:background .2s}
.tab-btn.active{background:#303060;color:#aaddff;border-color:#5577cc}
.tab-btn:hover:not(.active){background:#2a2a4a;color:#ccc}
.tab-pane{display:none}.tab-pane.active{display:block}
.columns{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.col{min-width:0;overflow-x:auto}
.col-left{flex:0 0 40%;min-width:300px}
.col-right{flex:1;min-width:300px}
#pwrt-overlay table{width:100%;border-collapse:collapse;table-layout:auto}
#pwrt-overlay th{background:#2a2a4a;color:#aaddff;padding:6px 8px;text-align:left;font-size:12px;white-space:nowrap;position:sticky;top:0;z-index:1}
#pwrt-overlay td{padding:5px 8px;border-bottom:1px solid #2a2a3a;vertical-align:top;word-break:break-word}
#pwrt-overlay tr:hover td{background:#22224a}
.bg-orange{background:#3a1f00!important}
.bg-red{background:#3a0010!important}
#pwrt-overlay a{color:#88ccff;text-decoration:none}
#pwrt-overlay a:hover{text-decoration:underline}
.ts{color:#aaa;font-size:11px;white-space:nowrap}
.rw{color:#66dd88;font-weight:bold}
.rl{color:#ff6666;font-weight:bold}
.ac{color:#ccaa66;font-size:13px}
.tc{color:#aaa;font-size:13px;white-space:nowrap}
.slbl{font-size:11px;font-weight:bold;color:#aaa;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px}
.tl-legend{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 16px;font-size:12px;color:#ccc}
.leg-item{display:flex;align-items:center;gap:5px}
.leg-dot{display:inline-block;width:14px;height:14px;border-radius:3px;flex-shrink:0}
.tl-tooltip{display:none;position:fixed;background:#1e1e3a;border:1px solid #4455aa;border-radius:7px;padding:9px 13px;font-size:12px;color:#e0e0e0;pointer-events:none;z-index:9999;max-width:300px;box-shadow:0 4px 16px rgba(0,0,0,.6);line-height:1.6}
.tl-no-data{color:#556;font-style:italic;padding:16px 0}
.vtl-outer{margin:16px 0;user-select:none}
.vtl-header{display:flex;font-size:11px;color:#778;margin-bottom:6px;gap:4px}
.vtl-left-lbl{flex:1;text-align:right;padding-right:6px;color:#ff6666}
.vtl-center-lbl{flex:0 0 84px;text-align:center;color:#889}
.vtl-right-lbl{flex:1;text-align:left;padding-left:6px;color:#66dd88}
.vtl-body{display:flex;position:relative;min-height:400px}
.vtl-left{flex:1;position:relative;border-right:2px solid #2a3344;overflow:hidden}
.vtl-center-col{flex:0 0 84px;display:flex}
.vtl-track{width:14px;position:relative;background:#2a2a3a;flex-shrink:0}
.vtl-axis{flex:1;position:relative}
.vtl-right{flex:1;position:relative;border-left:2px solid #2a3344;overflow:hidden}
.vtl-seg{position:absolute;left:0;width:100%;border-radius:2px;cursor:pointer;opacity:.85;transition:opacity .15s;z-index:2;min-height:3px}
.vtl-seg:hover{opacity:1;z-index:10}
.vtl-bar-in{position:absolute;right:0;height:5px;min-width:3px;background:#dd4444;border-radius:3px 0 0 3px;cursor:pointer;transform:translateY(-2px);z-index:5;transition:opacity .15s}
.vtl-bar-out{position:absolute;left:0;height:5px;min-width:3px;background:#44cc66;border-radius:0 3px 3px 0;cursor:pointer;transform:translateY(-2px);z-index:5;transition:opacity .15s}
.vtl-bar-in:hover,.vtl-bar-out:hover{opacity:.6}
.vtl-tick{position:absolute;left:2px;transform:translateY(-50%);font-size:10px;color:#889;white-space:nowrap;pointer-events:none}
.vtl-date-label{position:absolute;left:18px;transform:translateY(-50%);font-size:11px;color:#7799cc;font-weight:bold;white-space:nowrap;pointer-events:none}
.dash-stats{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 8px}
.ds{background:#232340;border:1px solid #334;border-radius:7px;padding:11px 18px;min-width:160px;flex:1}
.ds .ds-lbl{font-size:11px;color:#778;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.ds .ds-pct{font-size:22px;font-weight:bold;margin-bottom:2px}
.ds .ds-abs{font-size:12px;color:#aaa}
.ds-blue .ds-pct{color:#5bc8f5}
.ds-red .ds-pct{color:#ff4444}
.ds-orange .ds-pct{color:#ff8833}
.ds-green .ds-pct{color:#44cc66}
.aa-grid{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
.aa-col{min-width:260px;flex:1}
.hour-chart-wrap{margin:12px 0 4px}
.hour-chart{display:flex;align-items:flex-end;gap:2px;height:100px}
.hour-bar{flex:1;border-radius:2px 2px 0 0;min-height:2px;cursor:pointer;transition:opacity .15s}
.hour-bar:hover{opacity:.7}
.hour-axis{display:flex;gap:2px;margin-top:3px}
.hour-lbl{flex:1;text-align:center;font-size:9px;color:#333;overflow:hidden}
.hour-lbl.show{color:#889;font-size:10px}

/* ── Torn PDA / Mobile responsive overrides ──────────────── */
#pwrt-trigger-bar {
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
#pwrt-bar-toggle { min-height: 40px; }
#pwrt-key-input, #pwrt-date-input {
  font-size: 16px !important; /* prevents iOS auto-zoom */
  min-height: 38px;
}
.pwrt-btn {
  min-height: 38px;
  min-width: 130px;
}
#pwrt-save-key { min-height: 38px; }
#pwrt-setup-hint {
  background: #1a2a3a;
  border: 1px solid #3355aa;
  border-radius: 5px;
  padding: 8px 12px;
  font-size: 12px;
  color: #aaccee;
  line-height: 1.6;
  max-width: 480px;
}
#pwrt-setup-hint strong { color: #e0c060; }
#pwrt-setup-hint a { color: #88ccff; }
@media (max-width: 640px) {
  #pwrt-bar-content { flex-direction: column; align-items: flex-start; gap: 8px; }
  #pwrt-key-input { width: 100%; box-sizing: border-box; }
  #pwrt-date-input { width: 100%; box-sizing: border-box; }
  .pwrt-btn { width: 100%; }
  #pwrt-save-key { width: 100%; text-align: center; }
  .summary { gap: 6px; }
  .sb, .sb-net { min-width: 90px; padding: 6px 10px; }
  .sb .val, .sb-net .val { font-size: 16px; }
  .tab-btn { padding: 8px 12px; font-size: 12px; }
  .columns { flex-direction: column; }
  .col-left, .col-right { min-width: 0; width: 100%; flex: none; }
}
`;



  // ── Inject UI on faction page ─────────────────────────────────
  function injectUI() {
    // Avoid double injection
    if (document.getElementById('pwrt-trigger-bar')) return;

    // Style
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Full-screen report overlay (closure variable – re-attached to body if needed)
    const overlay = document.createElement('div');
    overlay.id = 'pwrt-overlay';
    document.body.appendChild(overlay);

    // Trigger bar
    const pdaKey    = getPDAApiKey();
    const savedKey  = pdaKey ?? storeGet(KEY_STORE, '');
    const savedDate = storeGet(DATE_STORE, '') || todayStr();

    // Is this a first-time install (no key stored anywhere)?
    const isFirstRun = !pdaKey && !storeGet(KEY_STORE, '');

    // Build key section depending on context
    let keySection;
    if (pdaKey) {
      // Torn PDA injected the key via @grant torn_api_key – nothing to enter
      keySection = `<span id="pwrt-pda-key-info" style="background:#1a2a1a;border:1px solid #336633;border-radius:4px;padding:5px 10px;color:#88dd88;font-size:12px">🔑 API key provided by Torn PDA</span>`;
    } else {
      // Manual key entry (desktop extension or Torn PDA without auto-inject)
      keySection = `
        <input id="pwrt-key-input" type="password" placeholder="Torn API Key" value="${esc(savedKey)}" autocomplete="off">
        <button id="pwrt-save-key">Save Key</button>`;
    }

    // First-run setup hint (shown when no key is available yet)
    const setupHint = isFirstRun ? `
      <div id="pwrt-setup-hint">
        <strong>⚙ First-time setup</strong><br>
        Enter your <strong>Torn API key</strong> (Limited access or higher) and click <em>Save Key</em>.<br>
        Get your key: <a href="https://www.torn.com/preferences.php#tab=api" target="_blank">torn.com → Preferences → API</a>

      </div>` : '';

    const bar = document.createElement('div');
    bar.id = 'pwrt-trigger-bar';
    bar.innerHTML = `
      <div id="pwrt-bar-toggle">
        <h3>⚔ PWRT</h3>
        <span id="pwrt-toggle-arrow">▼</span>
        <span style="color:#778;font-size:11px">War Report – tap to open</span>
      </div>
      <div id="pwrt-bar-content">
        ${keySection}
        ${setupHint}
        <input id="pwrt-date-input" type="text" placeholder="DD.MM.YYYY" value="${esc(savedDate)}">
        <button class="pwrt-btn" id="pwrt-run-btn">Generate Report</button>
        <span id="pwrt-status"></span>
        <span id="pwrt-err-msg"></span>
      </div>
    `;

    // Insert bar inside the Torn content area, below the top stats bar but above
    // the "Faction" heading. Try several known Torn DOM anchors in priority order.
    // The stats/status bar sits in #top-page-links-list / .user-information / #bar-exterior.
    // The faction content starts at #faction-main or .faction-main or h4.title.
    // Strategy: find the faction heading or content root, insert bar before it.
    function insertBar() {
      // Torn wraps page content in .content-wrapper > .content
      // The faction page heading is typically an <h4> with class 'title' inside .content
      const anchors = [
        // Faction heading
        document.querySelector('#faction-main h4.title'),
        document.querySelector('#faction-main .title'),
        document.querySelector('.content-title'),
        document.querySelector('#faction-main'),
        // Generic Torn content container
        document.querySelector('#mainContainer'),
        document.querySelector('.content'),
      ];
      const anchor = anchors.find(el => el != null);
      if (anchor) {
        anchor.insertAdjacentElement('beforebegin', bar);
      } else {
        // Fallback: put it at the very start of body
        document.body.prepend(bar);
      }
    }
    insertBar();

    // Auto-expand on first install so the user sees the setup prompt
    if (isFirstRun) {
      bar.classList.add('pwrt-expanded');
    }

    // Toggle collapse / expand
    document.getElementById('pwrt-bar-toggle').addEventListener('click', () => {
      bar.classList.toggle('pwrt-expanded');
    });

    // Events
    const saveKeyBtn = document.getElementById('pwrt-save-key');
    if (saveKeyBtn) {
      saveKeyBtn.addEventListener('click', () => {
        const k = document.getElementById('pwrt-key-input').value.trim();
        storeSet(KEY_STORE, k);
        const hint = document.getElementById('pwrt-setup-hint');
        if (hint) hint.remove();
        showStatus('API key saved.', false);
      });
    }

    document.getElementById('pwrt-run-btn').addEventListener('click', async () => {
      // ── Outer nuclear catch – last-resort fallback if anything throws before ──
      // the inner try/catch (e.g. a synchronous error creating the loading UI).
      let _loadingEl = null;
      let _runBtn = null;
      try {

      _runBtn = document.getElementById('pwrt-run-btn');
      clearMessages();
      _runBtn.disabled = true;

      // ── Create a fresh loading overlay directly in <body> every time ───────
      // This can never be null or detached – avoids silent failures from SPA DOM removal.
      const loadingEl = document.createElement('div');
      _loadingEl = loadingEl;
      loadingEl.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(26,26,46,.92);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:Arial,sans-serif';
      loadingEl.innerHTML = [
        '<div id="pwrt-ls" style="width:48px;height:48px;border:4px solid rgba(51,51,102,.5);border-top-color:#aaddff;border-radius:50%;animation:pwrt-spin .8s linear infinite"></div>',
        '<div id="pwrt-lt" style="color:#aaddff;font-size:15px;font-weight:bold">Generating report…</div>',
        '<div id="pwrt-lm" style="color:#999;font-size:13px;margin-top:-8px">Validating…</div>',
        '<div id="pwrt-le" style="display:none;color:#ff9999;font-size:13px;max-width:85%;text-align:center;padding:16px 20px;background:#2a1212;border:2px solid #cc3333;border-radius:8px;line-height:1.7;word-break:break-word"></div>',
        '<button id="pwrt-lc" style="display:none;padding:10px 28px;background:#2a2a4a;border:1px solid #556;border-radius:6px;color:#ccc;font-size:14px;cursor:pointer">Close</button>'
      ].join('');
      document.body.appendChild(loadingEl);

      const lSpinner = loadingEl.querySelector('#pwrt-ls');
      const lTitle   = loadingEl.querySelector('#pwrt-lt');
      const lMsg     = loadingEl.querySelector('#pwrt-lm');
      const lErr     = loadingEl.querySelector('#pwrt-le');
      const lClose   = loadingEl.querySelector('#pwrt-lc');

      function setStatus(txt) { if (lMsg) lMsg.textContent = txt; }
      function showLoadingErr(html) {
        if (lSpinner) lSpinner.style.display = 'none';
        if (lTitle)   lTitle.textContent = '⚠ Failed';
        if (lMsg)     lMsg.style.display = 'none';
        if (lErr)   { lErr.innerHTML = html; lErr.style.display = 'block'; }
        if (lClose) {
          lClose.style.display = 'inline-block';
          lClose.onclick = function() { loadingEl.remove(); _runBtn.disabled = false; };
        }
      }

      // ── Validation ────────────────────────────────────────────────────────
      const pdaKeyNow = getPDAApiKey();
      const keyInput  = document.getElementById('pwrt-key-input');
      const key       = pdaKeyNow || (keyInput ? keyInput.value.trim() : '');
      const dateStr   = (document.getElementById('pwrt-date-input')?.value ?? '').trim();

      if (!key) {
        showLoadingErr('No API key found.<br>Enter your Torn API key in the field and click <em>Save Key</em>.');
        return;
      }
      if (!dateStr) {
        showLoadingErr('Please enter a date (DD.MM.YYYY).');
        return;
      }
      if (!/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
        showLoadingErr('Invalid date format — use <strong>DD.MM.YYYY</strong>.<br>Got: ' + esc(dateStr));
        return;
      }

      storeSet(DATE_STORE, dateStr);

      // ── Ensure report overlay is in the DOM ───────────────────────────────
      if (!document.body.contains(overlay)) document.body.appendChild(overlay);

      // ── Run report with hard 60s timeout ─────────────────────────────────
      let reportOk = false;
      try {
        const timeoutP = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('Report timed out after 60 s. Check your connection.')), 60000));
        const html = await Promise.race([runReport(key, dateStr, setStatus), timeoutP]);

        overlay.innerHTML = html;
        overlay.classList.add('active');
        // innerHTML does NOT execute <script> tags – recreate them manually.
        try {
          overlay.querySelectorAll('script').forEach(s => {
            const n = document.createElement('script');
            n.textContent = s.textContent;
            s.replaceWith(n);
          });
        } catch (scriptErr) {
          console.error('[PWRT] Script re-execution failed:', scriptErr);
        }
        reportOk = true;

      } catch (err) {
        console.error('[PWRT] Report generation failed:', err);
        showLoadingErr(esc(err.message || String(err)));
        bar.classList.add('pwrt-expanded');
      } finally {
        _runBtn.disabled = false;
        if (reportOk) loadingEl.remove();
      }

      // ── Close outer nuclear try/catch ─────────────────────────────────────
      } catch (outerErr) {
        console.error('[PWRT] Unexpected top-level error:', outerErr);
        // Nuclear fallback – always visible even if loadingEl creation failed
        try { if (_loadingEl) _loadingEl.remove(); } catch(_) {}
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(26,10,10,.95);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif';
        errDiv.innerHTML = '<div style="background:#2a1212;border:2px solid #ff4444;border-radius:10px;padding:28px 32px;max-width:88%;color:#ff9999;text-align:center;line-height:1.8">' +
          '<b style="font-size:17px;color:#ffaaaa">PWRT – Unexpected Error</b><br><br>' +
          '<span style="font-size:13px;word-break:break-word">' + esc(String(outerErr?.message || outerErr)) + '</span><br><br>' +
          '<button onclick="this.parentNode.parentNode.remove()" style="padding:9px 22px;background:#334;border:1px solid #556;border-radius:5px;color:#ccc;cursor:pointer;font-size:13px">Close</button>' +
          '</div>';
        document.body.appendChild(errDiv);
        try { if (_runBtn) _runBtn.disabled = false; } catch(_) {}
      }
    });
  }

  function showStatus(msg, isErr = false) {
    const el = document.getElementById(isErr ? 'pwrt-err-msg' : 'pwrt-status');
    if (el) el.textContent = msg;
  }
  function showErr(msg) { showStatus(msg, true); }
  function clearMessages() {
    const s = document.getElementById('pwrt-status');
    const e = document.getElementById('pwrt-err-msg');
    if (s) s.textContent = '';
    if (e) e.textContent = '';
  }

  // ── Wait for DOM readiness and inject ─────────────────────────
  function tryInject() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectUI);
    } else {
      injectUI();
    }
  }

  // Handle Torn's SPA navigation (hash changes on single-page transitions)
  let lastPath = location.pathname + location.search + location.hash;
  const observer = new MutationObserver(() => {
    const newPath = location.pathname + location.search + location.hash;
    if (newPath !== lastPath) {
      lastPath = newPath;
      // Re-inject when navigating back to factions page
      if (/factions\.php/.test(location.pathname)) {
        setTimeout(injectUI, 500);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  tryInject();
}());

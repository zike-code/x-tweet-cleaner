'use strict';
/**
 * server.js — local server for X Tweet Cleaner.
 * Binds to 127.0.0.1 only; nothing leaves the machine except requests to x.com.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const xapi = require('./xapi');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const CREDS_FILE = path.join(DATA_DIR, 'creds.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  phase: 'idle',           // idle | scanning | deleting | paused
  account: null,           // { screen_name, user_id, name, statuses_count }
  queue: [],               // items still to delete
  seen: new Set(),         // ids already collected in this scan
  doneIds: new Set(),      // ids already deleted (persisted)
  stats: { deleted: 0, unretweeted: 0, failed: 0, skipped: 0, scanned: 0 },
  failures: [],            // { id, error }
  options: defaultOptions(),
  pausedUntil: 0,
  lastError: null,
  stopRequested: false,
};

function defaultOptions() {
  return {
    includeReplies: true,
    includeRetweets: true,
    dryRun: true,
    delayMs: 1500,
    jitterMs: 700,
    dateFrom: '',          // YYYY-MM-DD — only delete from this date onwards
    dateTo: '',            // YYYY-MM-DD — only delete up to this date
    keepIds: [],           // ids to preserve
    continuous: true,      // rescan until the timeline comes back empty
    maxDeletes: 0,         // 0 = no limit
    maxScanPages: 0,       // 0 = scan the whole timeline
  };
}

// ── Logging + SSE ───────────────────────────────────────────────────────────
const clients = new Set();
const logBuffer = [];

function log(msg, level = 'info') {
  const line = { t: Date.now(), level, msg: String(msg) };
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.shift();
  console.log(`[${new Date(line.t).toLocaleTimeString()}] ${msg}`);
  broadcast({ type: 'log', line });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}

function pushState() {
  broadcast({ type: 'state', state: publicState() });
}

function publicState() {
  return {
    phase: state.phase,
    account: state.account,
    queueLength: state.queue.length,
    queuePreview: state.queue.slice(0, 40),
    stats: state.stats,
    failures: state.failures.slice(-50),
    options: state.options,
    pausedUntil: state.pausedUntil,
    lastError: state.lastError,
    hasCreds: !!creds,
  };
}

// ── Credentials ─────────────────────────────────────────────────────────────
let creds = null;
try {
  if (fs.existsSync(CREDS_FILE)) {
    creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    log('Credentials loaded from data/creds.json');
  }
} catch (e) { log(`Could not read creds.json: ${e.message}`, 'warn'); }

function saveCreds(c, persist) {
  creds = { auth_token: c.auth_token.trim(), ct0: c.ct0.trim(), ua: (c.ua || xapi.DEFAULT_UA).trim() };
  if (persist) {
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
    log('Credentials written to data/creds.json (delete the file when you are done)');
  }
}

// ── Persisted progress ──────────────────────────────────────────────────────
function progressFile() {
  return path.join(DATA_DIR, `progress-${state.account?.screen_name || 'unknown'}.json`);
}

function loadProgress() {
  try {
    const f = progressFile();
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      state.doneIds = new Set(j.doneIds || []);
      log(`Previous progress: ${state.doneIds.size} ids already processed`);
    }
  } catch {}
}

let saveTimer = null;
function saveProgressSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(progressFile(), JSON.stringify({
        screen_name: state.account?.screen_name,
        updatedAt: new Date().toISOString(),
        stats: state.stats,
        doneIds: [...state.doneIds],
      }, null, 2));
    } catch (e) { log(`Could not save progress: ${e.message}`, 'warn'); }
  }, 1500);
}

// ── Filters ─────────────────────────────────────────────────────────────────
function passesFilters(t) {
  const o = state.options;
  if (o.keepIds.includes(t.id)) return false;
  if (t.is_retweet && !o.includeRetweets) return false;
  if (t.is_reply && !o.includeReplies) return false;
  if (o.dateFrom || o.dateTo) {
    const d = t.created_at ? new Date(t.created_at) : null;
    if (!d || isNaN(d)) return true; // unknown date → do not filter it out
    if (o.dateFrom && d < new Date(o.dateFrom + 'T00:00:00Z')) return false;
    if (o.dateTo && d > new Date(o.dateTo + 'T23:59:59Z')) return false;
  }
  return true;
}

// ── Scan ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scanTimeline() {
  const maxPages = state.options.maxScanPages > 0 ? state.options.maxScanPages : 400;
  const ops = state.options.includeReplies ? ['UserTweetsAndReplies', 'UserTweets'] : ['UserTweets'];
  let added = 0;
  for (const op of ops) {
    let cursor = null;
    let emptyStreak = 0;
    for (let page = 0; page < maxPages; page++) {
      if (state.stopRequested) return added;
      const r = await xapi.fetchTimelinePage(creds, state.account.user_id, op, cursor, log);
      if (r.rateLimited) {
        const waitMs = Math.max(5000, r.resetAt - Date.now());
        log(`Rate limited on ${op} — waiting ${Math.ceil(waitMs / 1000)}s`, 'warn');
        state.phase = 'paused'; state.pausedUntil = Date.now() + waitMs; pushState();
        await sleep(waitMs);
        state.phase = 'scanning'; state.pausedUntil = 0; pushState();
        continue;
      }
      if (r.error) { log(r.error, 'error'); state.lastError = r.error; break; }

      state.stats.scanned += r.tweets.length;
      let newHere = 0;
      for (const t of r.tweets) {
        if (state.seen.has(t.id) || state.doneIds.has(t.id)) continue;
        state.seen.add(t.id);
        if (!passesFilters(t)) { state.stats.skipped++; continue; }
        state.queue.push(t);
        newHere++; added++;
      }
      log(`${op} page ${page + 1}: ${r.tweets.length} items, ${newHere} new in queue (queue total: ${state.queue.length})`);
      pushState();

      if (!r.cursor || r.cursor === cursor) break;
      cursor = r.cursor;
      if (r.tweets.length === 0) { if (++emptyStreak >= 3) break; } else emptyStreak = 0;
      await sleep(900 + Math.random() * 600);
    }
  }
  return added;
}

// ── Delete loop ─────────────────────────────────────────────────────────────
async function deleteLoop() {
  const o = state.options;
  while (state.queue.length && !state.stopRequested) {
    if (o.maxDeletes && (state.stats.deleted + state.stats.unretweeted) >= o.maxDeletes) {
      log(`Limit of ${o.maxDeletes} reached — stopping.`);
      break;
    }
    const t = state.queue[0];

    if (o.dryRun) {
      log(`[DRY RUN] would ${t.is_retweet ? 'undo retweet' : 'delete'} ${t.id} — "${t.text.slice(0, 80)}"`);
      state.queue.shift();
      state.stats[t.is_retweet ? 'unretweeted' : 'deleted']++;
      pushState();
      await sleep(40);
      continue;
    }

    const r = t.is_retweet && t.source_id
      ? await xapi.undoRetweet(creds, t.source_id, log)
      : await xapi.deleteTweet(creds, t.id, log);

    if (r.rateLimited) {
      const waitMs = Math.max(10000, r.resetAt - Date.now());
      log(`Rate limited while deleting — pausing ${Math.ceil(waitMs / 1000)}s (queue is kept)`, 'warn');
      state.phase = 'paused'; state.pausedUntil = Date.now() + waitMs; pushState();
      await sleep(waitMs);
      state.phase = 'deleting'; state.pausedUntil = 0; pushState();
      continue; // retry the same item
    }

    state.queue.shift();

    if (r.ok) {
      state.doneIds.add(t.id);
      state.stats[t.is_retweet ? 'unretweeted' : 'deleted']++;
      const tag = r.alreadyGone ? 'already gone' : (t.is_retweet ? 'retweet undone' : 'deleted');
      log(`✓ ${tag} ${t.id} — "${t.text.slice(0, 70)}"`);
      saveProgressSoon();
    } else {
      state.stats.failed++;
      state.failures.push({ id: t.id, error: r.error });
      log(`✗ ${t.id}: ${r.error}`, 'error');
      if (r.fatal) {
        state.lastError = r.error;
        log('Fatal auth error — stopping. Refresh auth_token/ct0.', 'error');
        state.stopRequested = true;
        break;
      }
    }
    pushState();
    await sleep(o.delayMs + Math.random() * o.jitterMs);
  }
}

async function runJob() {
  state.stopRequested = false;
  state.lastError = null;
  // `seen` only de-duplicates within a scan; without this reset a second run
  // would consider everything already seen and find nothing. doneIds (which is
  // persisted) is what prevents redoing finished work.
  state.seen = new Set(state.queue.map(t => t.id));
  try {
    let pass = 0;
    for (;;) {
      pass++;
      state.phase = 'scanning'; pushState();
      const o = state.options;
      const filters = [
        o.includeReplies ? 'replies' : 'no replies',
        o.includeRetweets ? 'retweets' : 'no retweets',
        o.dateFrom || o.dateTo ? `dates ${o.dateFrom || '…'} → ${o.dateTo || '…'}` : 'no date filter',
        o.keepIds.length ? `${o.keepIds.length} ids kept` : null,
      ].filter(Boolean).join(' · ');
      log(`— Pass ${pass}: scanning timeline (${filters}) —`);
      const skippedBefore = state.stats.skipped;
      const added = await scanTimeline();
      const skippedNow = state.stats.skipped - skippedBefore;
      if (added === 0 && skippedNow > 0) {
        log(`Heads up: ${skippedNow} items were dropped by the filters and nothing entered the queue. Check the dates and the "what to delete" boxes.`, 'warn');
      }
      if (state.stopRequested) break;
      if (!state.queue.length) {
        log(added === 0 && pass > 1
          ? 'Nothing left in the timeline. Done.'
          : 'Nothing to delete with the current filters.');
        break;
      }
      state.phase = 'deleting'; pushState();
      log(`Processing ${state.queue.length} items${state.options.dryRun ? ' (DRY RUN)' : ''}...`);
      await deleteLoop();
      if (state.stopRequested) break;
      if (!state.options.continuous) break;
      if (state.options.maxDeletes && (state.stats.deleted + state.stats.unretweeted) >= state.options.maxDeletes) break;
      log('Queue empty — rescanning for posts the API did not show before...');
      // In a dry run nothing is deleted and nothing enters doneIds, so clearing
      // `seen` would make the same timeline reappear forever.
      if (state.options.dryRun) { log('Dry run: one pass is enough — stopping here.'); break; }
      state.seen.clear();
      await sleep(3000);
    }
  } catch (e) {
    state.lastError = e.message;
    log(`Unexpected error: ${e.stack || e.message}`, 'error');
  } finally {
    state.phase = 'idle';
    state.pausedUntil = 0;
    saveProgressSoon();
    log(`Finished. Deleted: ${state.stats.deleted} | Retweets undone: ${state.stats.unretweeted} | Failed: ${state.stats.failed} | Filtered out: ${state.stats.skipped}`);
    pushState();
  }
}

// ── Import the official archive (tweets.js from the X data export) ──────────
function importArchive(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const jsonStart = raw.indexOf('[');
  const arr = JSON.parse(raw.slice(jsonStart));
  let added = 0;
  for (const row of arr) {
    const tw = row.tweet || row;
    const id = tw.id_str || tw.id;
    if (!id || state.seen.has(String(id)) || state.doneIds.has(String(id))) continue;
    const item = {
      id: String(id),
      text: (tw.full_text || tw.text || '').replace(/\s+/g, ' ').slice(0, 220),
      created_at: tw.created_at || null,
      is_retweet: /^RT @/.test(tw.full_text || tw.text || ''),
      source_id: null,
      is_reply: !!tw.in_reply_to_status_id_str,
    };
    state.seen.add(item.id);
    if (!passesFilters(item)) { state.stats.skipped++; continue; }
    state.queue.push(item);
    added++;
  }
  return { added, total: arr.length };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
      for (const line of logBuffer.slice(-200)) res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/state') return send(200, publicState());

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.auth_token || !body.ct0) return send(400, { error: 'auth_token and ct0 are required' });
      saveCreds(body, !!body.remember);
      const acc = await xapi.whoami(creds, log);
      state.account = acc;
      state.stats = { deleted: 0, unretweeted: 0, failed: 0, skipped: 0, scanned: 0 };
      state.queue = []; state.seen.clear(); state.failures = [];
      loadProgress();
      log(`Session valid: @${acc.screen_name} (${acc.name}) — id ${acc.user_id}, ${acc.statuses_count ?? '?'} posts`);
      pushState();
      return send(200, { account: acc });
    }

    if (url.pathname === '/api/options' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.dateFrom && body.dateTo && body.dateFrom > body.dateTo) {
        return send(400, { error: `Date range is inverted: "from" (${body.dateFrom}) is after "to" (${body.dateTo}) — nothing would pass the filter.` });
      }
      state.options = {
        ...state.options,
        ...body,
        keepIds: (Array.isArray(body.keepIds) ? body.keepIds : String(body.keepIds || '').split(/[\s,]+/))
          .map(s => String(s).trim()).filter(Boolean),
      };
      pushState();
      return send(200, { options: state.options });
    }

    if (url.pathname === '/api/start' && req.method === 'POST') {
      if (!creds || !state.account) return send(400, { error: 'Connect first (auth_token + ct0)' });
      if (state.phase !== 'idle') return send(409, { error: 'Already running' });
      runJob();
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      state.stopRequested = true;
      log('Stop requested — finishing after the current item.', 'warn');
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path || !fs.existsSync(body.path)) return send(400, { error: 'Path not found' });
      const r = importArchive(body.path);
      log(`Archive imported: ${r.added} new items queued (out of ${r.total} in the file)`);
      pushState();
      return send(200, r);
    }

    if (url.pathname === '/api/reset-progress' && req.method === 'POST') {
      state.doneIds.clear(); state.seen.clear(); state.queue = [];
      state.stats = { deleted: 0, unretweeted: 0, failed: 0, skipped: 0, scanned: 0 };
      state.failures = [];
      saveProgressSoon();
      log('Progress reset.');
      pushState();
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/forget' && req.method === 'POST') {
      creds = null; state.account = null;
      try { if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE); } catch {}
      log('Credentials forgotten and creds.json deleted.');
      pushState();
      return send(200, { ok: true });
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  X Tweet Cleaner  →  http://127.0.0.1:${PORT}\n`);
});

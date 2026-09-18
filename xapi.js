'use strict';
/**
 * xapi.js — access layer for the internal X (x.com) GraphQL API.
 *
 *   - Public web-client bearer + auth_token/ct0 cookies + x-csrf-token
 *   - queryIds scraped from the bundle served on /search (the homepage moved to
 *     a Vite/ESM build and no longer exposes them)
 *   - x-client-transaction-id when the library is available
 */

const path = require('path');
const { pathToFileURL } = require('url');

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Where the optional TID library may live. Set X_TID_MODULE to point at an
// installation somewhere else on disk.
const TID_CANDIDATES = [
  'x-client-transaction-id',
  path.join(__dirname, 'node_modules', 'x-client-transaction-id', 'esm', 'mod.js'),
  process.env.X_TID_MODULE,
].filter(Boolean);

// ── queryIds ────────────────────────────────────────────────────────────────
// Verified against the x.com bundle on 2026-09-17. X rotates these regularly —
// discovery below is the normal path, these are the safety net for when the
// scrape fails.
const FALLBACK_IDS = {
  Viewer:               '9t128XgFic52jPUEkJMf6w',
  UserByScreenName:     'KybxDj9RrADIITXlGG8kpw',
  UserTweets:           'jeAA-59Y9FL7FmjgBNIVPw',
  UserTweetsAndReplies: 'wI-ubAWfScnG6odLK4XgCg',
  DeleteTweet:          'nxpZCY2K-I6QoFHAHeojFQ',
  DeleteRetweet:        'ZyZigVsNiFO6v1dEks1eWg',
};

let queryIds = { ...FALLBACK_IDS };
let queryIdsFetchedAt = 0;

async function discoverQueryIds(log = () => {}) {
  if (Date.now() - queryIdsFetchedAt < 6 * 60 * 60 * 1000) return queryIds;
  const found = {};
  try {
    const res = await fetch('https://x.com/search?q=a&src=typed_query', {
      headers: { 'user-agent': DEFAULT_UA, accept: 'text/html' },
    });
    const html = await res.text();
    const jsUrls = [...html.matchAll(/src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"]+\.js)"/g)].map(m => m[1]);
    for (const url of jsUrls.slice(0, 6)) {
      const r = await fetch(url, { headers: { 'user-agent': DEFAULT_UA } });
      if (!r.ok) continue;
      const js = await r.text();
      for (const op of Object.keys(FALLBACK_IDS)) {
        if (found[op]) continue;
        const m = js.match(new RegExp('queryId:"([^"]{15,30})",operationName:"' + op + '"'));
        if (m) found[op] = m[1];
      }
      if (Object.keys(found).length === Object.keys(FALLBACK_IDS).length) break;
    }
  } catch (e) {
    log(`[queryIds] discovery failed (${e.message}) — using fallbacks`);
  }
  queryIds = { ...FALLBACK_IDS, ...found };
  const nFound = Object.keys(found).length;
  if (nFound) {
    queryIdsFetchedAt = Date.now();
    log(`[queryIds] ${nFound}/${Object.keys(FALLBACK_IDS).length} read from bundle: ${Object.entries(found).map(([k, v]) => k + '=' + v).join(' ')}`);
  }
  const missing = Object.keys(FALLBACK_IDS).filter(k => !found[k]);
  if (missing.length) log(`[queryIds] hardcoded fallback for: ${missing.join(', ')}`);
  return queryIds;
}

// ── x-client-transaction-id ─────────────────────────────────────────────────
let tidMod = null, tidInstance = null, tidExpiry = 0;

async function loadTidModule(log) {
  if (tidMod !== null) return tidMod;
  for (const spec of TID_CANDIDATES) {
    try {
      const target = (spec.includes('/') || spec.includes('\\')) ? pathToFileURL(spec).href : spec;
      tidMod = await import(target);
      log('[TID] x-client-transaction-id loaded');
      return tidMod;
    } catch { /* try the next candidate */ }
  }
  tidMod = false;
  log('[TID] library not found — continuing without TID (some endpoints may 404)');
  return tidMod;
}

async function generateTID(method, gqlPath, log = () => {}) {
  const mod = await loadTidModule(log);
  if (!mod) return null;
  try {
    if (!tidInstance || Date.now() > tidExpiry) {
      const document = await mod.handleXMigration();
      tidInstance = await mod.ClientTransaction.create(document);
      tidExpiry = Date.now() + 4 * 60 * 60 * 1000;
      log('[TID] ClientTransaction initialised');
    }
    return await tidInstance.generateTransactionId(method, gqlPath);
  } catch (e) {
    tidInstance = null;
    log(`[TID] failed: ${e.message}`);
    return null;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function buildHeaders(creds) {
  return {
    authorization: BEARER,
    cookie: `auth_token=${creds.auth_token}; ct0=${creds.ct0}`,
    'x-csrf-token': creds.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
    'user-agent': creds.ua || DEFAULT_UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://x.com/',
    origin: 'https://x.com',
  };
}

async function gqlGet(creds, op, variables, features, fieldToggles, log) {
  await discoverQueryIds(log);
  const gqlPath = `/i/api/graphql/${queryIds[op]}/${op}`;
  const qs = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(features) });
  if (fieldToggles) qs.set('fieldToggles', JSON.stringify(fieldToggles));
  const headers = buildHeaders(creds);
  const tid = await generateTID('GET', gqlPath, log);
  if (tid) headers['x-client-transaction-id'] = tid;
  const res = await fetch(`https://x.com${gqlPath}?${qs}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function gqlPost(creds, op, variables, log) {
  await discoverQueryIds(log);
  const gqlPath = `/i/api/graphql/${queryIds[op]}/${op}`;
  const headers = buildHeaders(creds);
  const tid = await generateTID('POST', gqlPath, log);
  if (tid) headers['x-client-transaction-id'] = tid;
  const res = await fetch(`https://x.com${gqlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ variables, queryId: queryIds[op] }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// ── Account ─────────────────────────────────────────────────────────────────
// The REST 1.1 endpoints (account/settings.json, verify_credentials) now return
// 404 for the web-client bearer, so identity comes from the Viewer query.
async function whoami(creds, log = () => {}) {
  const VIEWER_FEATURES = {
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };
  const r = await gqlGet(creds, 'Viewer', { withCommunitiesMemberships: true }, VIEWER_FEATURES, null, log);
  if (r.status === 401 || r.status === 403) throw new Error(`Viewer HTTP ${r.status} — auth_token/ct0 invalid or expired`);
  if (r.status !== 200) throw new Error(`Viewer HTTP ${r.status} — ${r.text.slice(0, 200)}`);
  if (r.json?.errors?.length) throw new Error(`Viewer: ${r.json.errors[0].message}`);

  const u = r.json?.data?.viewer?.user_results?.result;
  if (!u?.rest_id) throw new Error('Viewer returned no user — session is probably invalid');
  const core = u.core || {};
  const legacy = u.legacy || {};

  const account = {
    screen_name: core.screen_name || legacy.screen_name,
    user_id: u.rest_id,
    name: core.name || legacy.name || core.screen_name,
    statuses_count: u.tweet_counts?.tweets ?? legacy.statuses_count ?? null,
  };

  // Viewer does not carry the post count — ask the profile query (not critical)
  if (account.statuses_count === null && account.screen_name) {
    try {
      const p = await gqlGet(creds, 'UserByScreenName', { screen_name: account.screen_name }, {
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      }, null, log);
      const pr = p.json?.data?.user?.result;
      account.statuses_count = pr?.tweet_counts?.tweets ?? pr?.legacy?.statuses_count ?? null;
    } catch { /* optional */ }
  }
  return account;
}

// ── Timeline ────────────────────────────────────────────────────────────────
const TL_FEATURES = {
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

function parseTweetResult(result, ownerId) {
  if (!result) return null;
  const node = result.tweet || result;
  const legacy = node.legacy;
  if (!legacy) return null;
  const rtResult = legacy.retweeted_status_result?.result;
  const sourceId = rtResult?.rest_id || rtResult?.tweet?.rest_id || legacy.retweeted_status_id_str || null;
  const authorId = legacy.user_id_str || node.core?.user_results?.result?.rest_id;
  // Timelines include other people's posts inside conversations — drop those
  if (ownerId && authorId && authorId !== ownerId) return null;
  return {
    id: legacy.id_str || node.rest_id,
    text: (legacy.full_text || legacy.text || '').replace(/\s+/g, ' ').slice(0, 220),
    created_at: legacy.created_at || null,
    is_retweet: !!sourceId,
    source_id: sourceId,
    is_reply: !!legacy.in_reply_to_status_id_str,
    favorite_count: legacy.favorite_count ?? 0,
    retweet_count: legacy.retweet_count ?? 0,
  };
}

function walkEntries(instructions, ownerId) {
  const tweets = [];
  let cursor = null;
  for (const instr of instructions || []) {
    const entries = instr.entries || (instr.entry ? [instr.entry] : []);
    for (const entry of entries) {
      const eid = entry.entryId || '';
      if (eid.startsWith('cursor-bottom') || entry.content?.cursorType === 'Bottom') {
        cursor = entry.content?.value || entry.content?.itemContent?.value || cursor;
        continue;
      }
      const direct = parseTweetResult(entry.content?.itemContent?.tweet_results?.result, ownerId);
      if (direct) tweets.push(direct);
      for (const item of entry.content?.items || []) {
        if ((item.entryId || '').includes('cursor-showmore')) continue;
        const t = parseTweetResult(item.item?.itemContent?.tweet_results?.result, ownerId);
        if (t) tweets.push(t);
      }
    }
  }
  return { tweets, cursor };
}

/** One timeline page. op = 'UserTweets' | 'UserTweetsAndReplies' */
async function fetchTimelinePage(creds, userId, op, cursor, log) {
  const variables = {
    userId,
    count: 100,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: true,
    withCommunity: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;
  const r = await gqlGet(creds, op, variables, TL_FEATURES, null, log);
  if (r.status === 429) {
    const reset = Number(r.headers.get('x-rate-limit-reset') || 0);
    return { rateLimited: true, resetAt: reset ? reset * 1000 : Date.now() + 60000, tweets: [], cursor };
  }
  if (r.status !== 200) {
    return { error: `${op} HTTP ${r.status}: ${r.text.slice(0, 200)}`, tweets: [], cursor: null };
  }
  const u = r.json?.data?.user?.result;
  const timeline = u?.timeline_v2?.timeline || u?.timeline?.timeline;
  if (!timeline) return { error: `${op}: response had no timeline (suspended or protected account?)`, tweets: [], cursor: null };
  const { tweets, cursor: next } = walkEntries(timeline.instructions, userId);
  return { tweets, cursor: next };
}

// ── Mutations ───────────────────────────────────────────────────────────────
function interpretMutation(r, kind) {
  if (r.status === 429) {
    const reset = Number(r.headers.get('x-rate-limit-reset') || 0);
    return { ok: false, rateLimited: true, resetAt: reset ? reset * 1000 : Date.now() + 15 * 60000, error: 'rate limit (429)' };
  }
  if (r.status === 200) {
    const errs = r.json?.errors;
    if (errs?.length) {
      const msg = errs[0].message || 'unknown error';
      // Already gone → count as done, otherwise the item jams the queue
      if (/not found|no status found|does not exist|page does not exist/i.test(msg)) {
        return { ok: true, alreadyGone: true };
      }
      return { ok: false, error: msg };
    }
    const done = kind === 'delete'
      ? r.json?.data?.delete_tweet !== undefined
      : r.json?.data?.unretweet !== undefined;
    return { ok: done || r.json?.data !== undefined, error: done ? null : 'unexpected response' };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, fatal: true, error: `HTTP ${r.status} — invalid session (auth_token/ct0)` };
  if (r.status === 404) return { ok: false, error: 'HTTP 404 — stale queryId or the post no longer exists' };
  return { ok: false, error: `HTTP ${r.status}: ${r.text.slice(0, 160)}` };
}

async function deleteTweet(creds, tweetId, log) {
  const r = await gqlPost(creds, 'DeleteTweet', { tweet_id: tweetId, dark_request: false }, log);
  return interpretMutation(r, 'delete');
}

async function undoRetweet(creds, sourceTweetId, log) {
  const r = await gqlPost(creds, 'DeleteRetweet', { source_tweet_id: sourceTweetId, dark_request: false }, log);
  return interpretMutation(r, 'unretweet');
}

module.exports = {
  DEFAULT_UA,
  discoverQueryIds,
  getQueryIds: () => queryIds,
  whoami,
  fetchTimelinePage,
  deleteTweet,
  undoRetweet,
};

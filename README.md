# X Tweet Cleaner

Bulk-delete the posts on your own X (Twitter) account from a small local web UI.
No dependencies — Node 18+ is all you need (tested on Node 24).

```
node server.js
```

Then open **http://127.0.0.1:8787**. Session, filters and pace sit on the left;
progress, the pending queue and a live log on the right.

## How it works

It talks to the internal x.com GraphQL API the same way the web client does:

| Piece | Detail |
|---|---|
| Auth | public web-client bearer + `auth_token`/`ct0` cookies + `x-csrf-token` |
| Identity | `Viewer` query — the REST 1.1 endpoints (`account/settings.json`, `verify_credentials`) have returned 404 since X retired them |
| Listing | `UserTweetsAndReplies` + `UserTweets`, cursor-paginated |
| Deleting | `DeleteTweet` mutation; retweets go through `DeleteRetweet` with the `source_tweet_id` |
| queryIds | scraped from the bundle served on `/search?q=a&src=typed_query` (the homepage moved to a Vite build and no longer exposes them), with hardcoded fallbacks verified 2026-09-17 |
| `x-client-transaction-id` | optional — used automatically if the [`x-client-transaction-id`](https://www.npmjs.com/package/x-client-transaction-id) package is installed, or if `X_TID_MODULE` points at one |

## Getting your cookies

1. Open x.com logged in as the account you want to clear.
2. DevTools → Application → Cookies → `https://x.com`.
3. Copy the values of `auth_token` and `ct0`.

`auth_token` is the whole session for that account. Keep it off screenshots and
shared machines, and log the session out when you are done.

## Flow

1. **Session** — paste `auth_token` and `ct0`. The button confirms which account
   it reached before anything else happens.
2. **What to delete** — replies, retweets, a date range, ids to keep.
3. **Pace** — delay between requests and a cap for the run.
4. **Dry run is on by default**: it scans and lists everything it *would* delete
   without touching anything.
5. Turn the dry run off, confirm twice (the second prompt wants the word
   `DELETE`), and let it run.

Progress is written to `data/progress-<account>.json`. If you stop halfway — or
the session expires — you can resume; anything already deleted is not retried.

## Limits worth knowing

- The timeline only serves ~3200 recent posts. With *rescan until the timeline is
  empty* on, the tool re-scans after each pass and peels the history back layer
  by layer.
- For larger accounts, request the official archive under *Settings → Your
  account → Download an archive of your data* and import `data/tweets.js` from
  the Extra panel: the ids then come from the file instead of the timeline.
- On HTTP 429 it pauses until `x-rate-limit-reset` and resumes on its own without
  losing the queue.
- Delays under ~1s make 429s much more likely. 1500 ms ± 700 is a safe pace
  (roughly 2000 posts/hour).

## Privacy

- The server binds to `127.0.0.1` only. Nothing leaves the machine except the
  requests to x.com.
- `data/creds.json` is written only if you tick *save*; *Forget credentials*
  deletes it. `data/` is gitignored.

## Disclaimer

This uses X's private web API, which can change without notice — when a `queryId`
rotates, the scraper picks up the new one, but a larger redesign may need a fix.
Deleting is permanent. Use it on accounts you own, at your own risk.

MIT licensed.

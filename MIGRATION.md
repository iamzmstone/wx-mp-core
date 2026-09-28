# MIGRATION: roll wx-mp-core into bmt-game-miniprogram

This is the step-by-step plan to actually wire the submodule into the
existing app. The submodule files (`src/http.js`, `README.md`,
`package.json`) are already written; what remains is the consumer side.

## Phase 0 — submodule plumbing (one-time)

The submodule needs a remote git repo first. Two options:

**Option A: separate repo (recommended for multi-project reuse)**

```bash
# On the host where the wx-mp-core remote will live:
mkdir wx-mp-core && cd wx-mp-core
git init --bare   # or push to GitHub later

# In this repo (bmt-game):
cd /Users/zengmin/app/bb/bmt_game
git submodule add <wx-mp-core-remote-url> lib/wx-mp-core
# At this point lib/wx-mp-core gets re-cloned from the remote, which
# is empty — copy our POC files in:
rm -rf lib/wx-mp-core/*
cp -R path/to/poc/{src,README.md,package.json,MIGRATION.md} lib/wx-mp-core/
cd lib/wx-mp-core && git add -A && git commit -m "Initial POC" && git push
cd ../..
git add lib/wx-mp-core
git commit -m "Add wx-mp-core submodule"
```

**Option B: keep it in-tree for now (skip the remote)**

```bash
cd /Users/zengmin/app/bb/bmt_game
git rm --cached lib/wx-mp-core    # if it was already added as a submodule placeholder
# Just keep the directory as a regular subdirectory tracked by bmt-game's
# main repo. Cheaper to set up; harder to share.
```

For the POC, we've taken Option B — `lib/wx-mp-core/` is just files in
the bmt-game repo. Migrating to Option A is one `git submodule add`
away once the project count grows past 1.

## Phase 1 — swap the require path (zero behaviour change) ✅ DONE

Goal: prove the submodule's HTTP wrapper is a drop-in replacement for
`bmt-game-miniprogram/services/api.js`. No semantic changes — just
point the existing require at the new module.

**1a. Update `bmt-game-miniprogram/services/api.js`:**

The simplest migration is to make `services/api.js` a thin re-export of
the submodule's singleton. Use a **relative path** — WeChat developer
tools do not resolve bare module names without either a `paths` mapping
in `project.config.json` or a `miniprogram_npm` build. Relative paths
work immediately with no config changes:

```js
// bmt-game-miniprogram/services/api.js  (after migration)
//
// Thin re-export of the wx-mp-core HTTP singleton. Source of truth is
// bmt-game-miniprogram/lib/wx-mp-core/src/http.js. Kept as a local
// file so the rest of the codebase doesn't have to learn a new require
// path. Delete this file once Phase 2 lands and every caller points
// directly at wx-mp-core.
module.exports = require('../lib/wx-mp-core/src/http').default;
```

(Note: the path is `../lib/...` here only because `services/api.js`
sits at one level deep. Once Phase 2 deletes this file, each caller
uses the appropriate depth for its own location.)

**1b. Verified at the Node level (no MP devtools required):**

```bash
$ node -e "
  const api = require('./bmt-game-miniprogram/services/api');
  console.log(Object.keys(api).sort().join(','));
"
absUrl,del,delete,get,post,put,request,upload
```

Singleton check (the re-export must point at the same instance, not a
copy — otherwise two HTTP wrappers would race for `globalData.token`):

```bash
$ node -e "
  const api = require('./bmt-game-miniprogram/services/api');
  const { default: core } = require('./lib/wx-mp-core/src/http');
  console.log(api === core);
"
true
```

**1c. Manual smoke test in the WeChat developer tools:**

- Open the MP project in the WeChat developer tools.
- Open the home page → activities should load identically.
- Trigger a 401 (e.g. clear storage + reload) → should redirect to
  `/pages/index/index?needLogin=true` exactly as before.
- Trigger a network error (devtools → network → offline) → should
  show "网络请求失败" toast.
- Trigger a background call (badge refresh on cold start) → should
  *not* show a toast on failure.

If all four match the pre-migration behaviour, the POC is wired in.

**Phase 1 results (this repo):**

- 17 caller sites confirmed untouched — all use `const api = require(...)`
  followed by `api.get/post/put/upload/absUrl`, no destructuring.
- Re-export resolves cleanly under Node, exports match the legacy
  shape exactly (8 methods), and `api === core.default` is true
  (singleton identity preserved).
- Pending: the four manual smoke tests in the WeChat devtools
  console, which need a live MP environment to run.

## Phase 2 — remove the legacy `services/api.js` ✅ DONE

Once every caller is confirmed on the new path, delete the wrapper
and update requires. Done as one batch:

```bash
# Replace, scoped to the three relative-path depths that exist in
# the project (1 level for app.js, 2 for pages/*/index.js, 3 for
# pages/admin/admin-*\/index.js).
find bmt-game-miniprogram -name "*.js" -type f | xargs sed -i '' \
  -e "s|require('./services/api')|require('./lib/wx-mp-core/src/http').default|g" \
  -e "s|require('../../services/api')|require('../../lib/wx-mp-core/src/http').default|g" \
  -e "s|require('../../../services/api')|require('../../../lib/wx-mp-core/src/http').default|g"

rm bmt-game-miniprogram/services/api.js
```

**Verification (this repo):** all 17 caller sites updated, no
remaining references to `services/api`, and `services/api.js`
deleted. `lib/wx-mp-core/src/http`'s singleton still has the same 8
methods, so the rest of `services/` (now just `activity.js` and
`auth.js`) keeps working without changes.

`services/auth.js` is the only remaining `services/` file that talks
HTTP — it gets extracted into `lib/wx-mp-core/src/auth.js` in Phase 3.

### Post-mortem: patterns the first sed missed

The first cut of Phase 2 grepped `require.*services/api` and ended up
missing two real cases. When you do this in another consumer project,
search more broadly up front:

```bash
# Wrong (matches what we grepped for, but misses same-directory
# references like `require('./api')`):
grep -rn "require.*services/api" --include="*.js" <consumer>/

# Right — match any require ending in 'api' or pointing one level up
# at lib/<submodule>/...:
grep -rnE "require\(.*['\"]\.{1,2}/(api|lib)" --include="*.js" <consumer>/
```

What this caught in bmt-game after a first-pass miss:

- **`services/activity.js`** and **`services/auth.js`** used
  `require('./api')` (same-directory self-import), not
  `require('../../services/api')` (cross-directory import). The
  grep only matched the latter form.
- **`app.js`** (1-level deep under the miniprogram root) needed
  `../lib/wx-mp-core/src/http`, not `./lib/...` — the consumer's
  `lib/` lives at the repo root, not inside the miniprogram root.

After fixing those three, the final sed patterns that cover all
cases in bmt-game:

```bash
# app.js + everything directly under bmt-game-miniprogram/
sed -i '' "s|require('./lib/wx-mp-core/src/http')|require('../lib/wx-mp-core/src/http')|" app.js

# services/*.js — same-directory require('./api')
sed -i '' "s|require('./api')|require('../lib/wx-mp-core/src/http').default|" services/*.js

# pages/*/index.js — 2-level cross-directory require('../../services/api')
find pages -mindepth 2 -maxdepth 2 -name "*.js" \
  -exec sed -i '' "s|require('../../services/api')|require('../../lib/wx-mp-core/src/http').default|" {} +

# pages/admin/admin-*/index.js — 3-level
find pages/admin -mindepth 2 -name "*.js" \
  -exec sed -i '' "s|require('../../../services/api')|require('../../../lib/wx-mp-core/src/http').default|" {} +
```

The deeper lesson: when you mix relative require paths with a
module that lives *outside* the consumer root, the path depth you
need from each file depends on that file's position in the tree —
not on the consumer's "logical depth" (1/2/3 levels from root).
Working it out from a flat depth count is how the first cut missed
app.js.

### Post-mortem: the require path was correct, but the file was outside the MP root

Even after the require paths above were correct under Node, the
WeChat devtools console still showed:

```
can not find module : , require args is ../lib/wx-mp-core/src/http
  at app.js:48 refreshUnreadCount
module 'lib/wx-mp-core/src/http.js' is not defined, require args is '../lib/wx-mp-core/src/http'
  at services/activity.js:6
```

Root cause: **WeChat devtools only loads files that live under
the directory containing `project.config.json` (the `miniprogramRoot`)**.
Node.js happily resolves `../lib/...` because it has no such
restriction. WeChat's runtime does.

Fix: move the submodule *inside* the miniprogram root.

```bash
mkdir -p bmt-game-miniprogram/lib
mv lib/wx-mp-core bmt-game-miniprogram/lib/wx-mp-core

# app.js + services/*.js paths change from ../lib/ to ./lib/
# (pages/* and pages/admin/* paths are unaffected — they were
# always going up two or three levels to land in bmt-game-miniprogram/).
sed -i '' "s|require('../lib/wx-mp-core/src/http')|require('./lib/wx-mp-core/src/http')|" \
  app.js services/activity.js services/auth.js
```

After the move, every require path resolves to a file under
`bmt-game-miniprogram/` (which is the miniprogramRoot), and WeChat
devtools loads them.

This is a **runtime rule of the WeChat MP sandbox**, not a
fundamental limitation. If we ever need wx-mp-core to live at the
repo root (e.g. for sharing with a second MP), the workaround is
either `miniprogram_npm` packaging (Phase 6) or copying the
submodule into each MP at build time.

The Node smoke test that passed in the first cut did NOT catch
this — Node has no miniprogramRoot concept. To catch it earlier,
add a check that mirrors the devtools restriction:

```bash
# After every require-path rewrite, verify each require target is
# inside the miniprogramRoot. From bmt-game-miniprogram:
for f in $(grep -rl "wx-mp-core" --include="*.js" .); do
  grep -oE "require\(['\"][^'\"]+wx-mp-core[^'\"]*['\"]\)" "$f" \
    | sed -E "s|require\(['\"]([^'\"]+)['\"]\).*|\1|" \
    | while read p; do
        abs="$(cd "$(dirname "$f")" && realpath -m "$p")"
        case "$abs" in "$(pwd)"/*) ;; *) echo "OUTSIDE ROOT: $f → $p → $abs";; esac
      done
done
```

This will flag any `require` whose absolute target lives outside
the current working directory (the miniprogramRoot).

## Phase 3 — extract `services/auth.js` into `src/auth.js` ✅ DONE

The challenge: `auth.js` has hard-coded knowledge of this app's
profile-setup handshake (`need_profile_setup`, `temp_token`),
multiple backend endpoints, and a `hasDefaultUsername` regex using
the literal "用户". Solution: **factory + thin wrapper**.

### The factory: `lib/wx-mp-core/src/auth.js`

`createAuth(options)` returns the same 11-method shape the legacy
`services/auth.js` exposed (`wechatLogin`, `completeProfile`,
`checkSession`, `getCurrentUser`, `isLoggedIn`, `logout`,
`fetchCurrentUser`, `updateProfile`, `uploadAvatar`,
`deactivateAccount`, `requireLoginThen`).

Required options:
- `http` — a configured HTTP instance from `http.js` (passed through
  for login, profile-setup POST, avatar upload, etc.)
- `endpoints.login` — POST, body `{code}`, returns login response
- `endpoints.profileSetup` — POST, body `{avatar_url, nickname, gender}`,
  returns profile-setup response

Optional options (each enables a corresponding method):
- `endpoints.avatarUpload` — for `completeProfile` + `uploadAvatar`
- `endpoints.currentUser` — for `fetchCurrentUser`
- `endpoints.updateProfile` — for `updateProfile`
- `endpoints.deactivate` — for `deactivateAccount`
- `parseLoginResponse` / `parseProfileSetupResponse` — override
  default backend envelope handling
- `profileCompletionPath` — page path `requireLoginThen` navigates to
  on new-user detection (default: `/pages/profile-completion/index`)
- `onPrivacyError` / `onLoginFailure` — override UX
- `getToken` / `setToken` / `getUser` / `setUser` / `clearSession` /
  `getAfterLogin` / `setAfterLogin` — override session storage
  (defaults: `getApp().globalData`)

Session storage defaults use the **same lazy-`getApp()` pattern as
http.js** — the accessor functions call `getApp()` inside, not at
module load time, so `services/auth.js` can still be `require`d from
`app.js`'s `onLaunch` before `App()` is registered.

### The wrapper: `bmt-game-miniprogram/services/auth.js`

Reduced from **219 → 40 lines**. Wires the factory to bmt-game's
actual backend endpoints and adds the one project-specific helper:

```js
const { createAuth } = require('../lib/wx-mp-core/src/auth');
const http = require('../lib/wx-mp-core/src/http').default;

const auth = createAuth({
  http,
  endpoints: {
    login: '/api/auth/wechat',
    profileSetup: '/api/auth/wechat/complete-profile',
    avatarUpload: '/api/upload/avatar',
    currentUser: '/api/users/me',
    updateProfile: '/api/users/me',
    deactivate: '/api/users/me/deactivate',
  },
  profileCompletionPath: '/pages/profile-completion/index',
});

// Project-specific helper (the literal "用户" is project-flavored,
// so it lives here, not in the generic factory):
function hasDefaultUsername(userInfo) {
  return !!userInfo && /^用户.{6}$/.test(userInfo.username || '');
}

module.exports = Object.assign({}, auth, { hasDefaultUsername });
```

### Verification (this repo)

- All 12 exports present and typed as `function` (the 11 from the
  factory + `hasDefaultUsername` from the wrapper).
- 9 caller sites confirmed unchanged — `const auth =
  require('../../services/auth')` followed by `auth.xxx(...)`
  patterns. No caller needed editing.
- `node --check` passes on both the factory (392 lines) and the
  wrapper (40 lines).

### Method-call surface that has to keep working

(Useful when auditing the factory's return shape against the
legacy module's exports.)

```
16× auth.isLoggedIn(           ← most common, called in many
                                onLoad/onShow paths
10× auth.getCurrentUser(
 5× auth.requireLoginThen(     ← login gate pattern
 2× auth.logout(
 1× auth.wechatLogin(          ← direct login (e.g. profile-completion)
 1× auth.uploadAvatar(
 1× auth.updateProfile(
 1× auth.hasDefaultUsername(
 1× auth.fetchCurrentUser(
 1× auth.deactivateAccount(
 1× auth.completeProfile(
```

If you later swap to a different generic session storage strategy
(e.g. wx.storage directly instead of globalData), the factory's
injectable `getToken`/`setToken`/etc. options let you do that
without changing any caller — they read through your accessors.

## Phase 4 — extract design tokens & helpers

Lower priority; non-trivial review of which CSS rules are "really
generic" vs "look generic but encode BMT-specific choices". Plan a
dedicated pass with the design owner.

## Phase 5 — `app.js` bootstrap ✅ DONE

The env-switching (`develop` → `127.0.0.1`, `trial`/`release` →
production hosts) and privacy consent setup in `app.js` are
generic-enough to be a "fork this and edit the host map" template.
Land after auth + tokens are stable; the bootstrap is the easiest
piece but adding it earlier would tempt over-coupling.

### The helpers: `lib/wx-mp-core/src/bootstrap.js`

Two stateless helpers, both pure (no shared state, no surprising
side effects):

- `resolveApiBase(envMap, fallback)` — picks the right backend
  host for the current `envVersion`. Reads
  `wx.getAccountInfoSync().miniProgram.envVersion`, falls back if
  the API throws or returns an unknown value.
- `setupPrivacyConsent(logger, consentPath?)` — logs the current
  privacy state via `wx.getPrivacySetting` and registers a custom
  `wx.onNeedPrivacyAuthorization` handler that defers to the
  consumer's `wx.storage` consent record (`privacy_consent_v1`). When
  no prior consent is recorded, the handler navigates to the consent
  page (default `/pages/privacy/index`, override via second arg) using
  `wx.navigateTo` — **NOT** `wx.showModal`, which on base lib 3.16.x
  doesn't pause the flow. The trade-off: the privacy-sensitive API
  still resolves with `disagree`; the user retries after agreeing.
  This is审-friendly and works on 3.4.6+.

### The wrapper: `bmt-game-miniprogram/app.js`

Reduced from **111 → 69 lines (-38%)**. The env-switching block
(~16 lines) collapsed to a 6-line `resolveApiBase` call, and the
`_setupPrivacyAuth` method (~30 lines including踩坑 comments) was
deleted in favour of `setupPrivacyConsent()`. The boot comments
above each helper now live in `bootstrap.js` so the踩坑 record is
preserved in the right place.

What's left in `app.js` (and stays project-specific):

- `globalData` shape (`apiBase`, `userInfo`, `token`, `unreadCount`)
- Session restore from `wx.getStorageSync` on cold start
- `refreshUnreadCount()` (calls `/api/notifications/unread-count`
  — endpoint is bmt-game specific)
- `setToken` / `setUserInfo` / `clearSession` — write-through
  helpers used by `services/auth.js` via `app.setToken(...)` etc.

If we ever want to extract those too (see Phase 7 — `session.js`),
both `app.js` and `services/auth.js`'s default session accessors
could share a single source of truth.

### Verification (this repo)

- `resolveApiBase` returns the expected host for all 5 scenarios:
  develop, trial, release, unknown envVersion, and `getAccountInfoSync`
  throwing.
- `setupPrivacyConsent` doesn't throw and emits 2 log lines (privacy
  setting + consent-UI message) under a stub `wx`.
- All 30 .js files in `bmt-game-miniprogram/` still parse.

## Phase 6 (optional) — bare-name require via `miniprogram_npm`

If a consumer would rather write `require('wx-mp-core/src/http')` than
`require('../../lib/wx-mp-core/src/http')`, package the submodule as
an npm module and let WeChat devtools bundle it via
`miniprogram_npm`. This adds an `npm install` step and a small build
config; only worth it if the relative-path shape becomes a real
friction point.

```bash
# 1. Push wx-mp-core to a registry GitHub
# 2. In the consumer's package.json:
npm install wx-mp-core --save
# 3. In project.config.json:
#    "setting": { "packNpmManually": false }
# 4. Devtools → Tools → Build npm
# 5. Then you can write:
require('wx-mp-core/src/http')
```

This is **not** what we did in Phase 1 — relative path is simpler and
we already have a working solution. Phase 6 only fires if/when a second
consumer project shows up and asks for the cleaner require path.

## Phase 7 — extract session persistence into `src/session.js` ✅ DONE

Three layers in the consumer were each duplicating the same
`wx.setStorageSync` + `globalData.x = ...` write-through pattern,
and **one of them was missing half the pattern**. Closing that gap
is the actual win — the line count is roughly a wash.

### The bug surface this closes

Before Phase 7, `auth.js`'s default accessors only wrote to
`globalData` (cache). Storage was written exclusively from
`app.js`'s `setToken` / `setUserInfo` / `clearSession` wrappers.
If any caller bypassed those wrappers (e.g. a test, or a future
page that called `getApp().globalData.token = '...'` directly),
storage would be left stale and the next cold start would boot
into a logged-out UI while the http wrapper still attached the
old Bearer token.

### The helper: `lib/wx-mp-core/src/session.js`

Module-level stateless functions — no factory because the storage
and cache layers are WeChat-MP conventions, not consumer choices:

- `bootstrap()` — hydrate `globalData.token` + `globalData.userInfo`
  from `wx.storage`. Returns `true` if both keys were present.
  Call once from `app.js`'s onLaunch.
- `writeToken(t)` / `writeUser(u)` — write-through (cache + storage).
  Pass falsy to clear both layers.
- `clear()` — wipe both layers. Does NOT touch `afterLogin`
  (scratch slot, not session state).
- `getToken()` / `getUser()` / `getAfterLogin()` / `setAfterLogin(t)` —
  cache-only reads; assume `bootstrap()` has run.

Each `wx.*` call is wrapped in try/catch so a quota error or
privacy-reject during `setStorageSync` can't break the in-memory
cache (which is the layer every other read actually uses).

### Wiring changes

| File | Before | After |
|---|---|---|
| `bmt-game-miniprogram/app.js` | 12-line storage-write blocks in `setToken`/`setUserInfo`/`clearSession`; manual `getStorageSync`+conditional write in `onLaunch` | one-line `session.bootstrap()` + `session.writeToken/writeUser/clear` calls; `unreadCount` reset stays in app.js (it's app-level, not session-level) |
| `lib/wx-mp-core/src/auth.js` | 7 default accessor functions (~40 lines), each calling `getApp().globalData` lazy-style | 7 one-line aliases `userOptions.X || session.Y`; factory stays the same shape |
| `lib/wx-mp-core/src/http.js` | inline lazy-getApp for `getApiBase` + `getToken` in `defaultHttp` | `getToken` delegates to `session.getToken`; `getApiBase` stays inline (apiBase is a config concern set by `resolveApiBase`, not a session concern) |

### Verification (this repo)

- 24/24 round-trip assertions under Node with stubbed `wx` + `getApp`:
  writeToken/writeUser/clear touch both layers, bootstrap hydrates from
  storage, afterLogin is preserved across clear(), storage throws don't
  break the cache, `getApp()` returning null is safe.
- 6/7 wiring assertions confirm `auth.logout()` now clears BOTH cache
  and storage (the bug surface), custom `getToken` override still wins,
  and `createHttp({ getToken: session.getToken })` works.
- All 30+ .js files in `bmt-game-miniprogram/` still parse (`node --check`).

### What this did NOT do (deliberate)

- `apiBase` stayed out of `session.js`. It's a config concern set by
  `bootstrap.resolveApiBase`, not a session concern — adding it would
  force a coupling between bootstrap.js and session.js for no gain.
- `unreadCount` stays in app.js's `clearSession`/`setToken`. It's a
  derived notification badge (depends on a backend call), not a
  session fact.

## Phase 8a — `createResource` REST CRUD factory ✅ DONE

The remaining duplication after Phase 7 was in `services/activity.js`:
five of its ten functions were thin CRUD wrappers that all looked the
same:

```js
const getActivities  = (params) => api.get(`/api/activities?...`, params);
const getActivity    = (id) => api.get(`/api/activities/${id}`);
const createActivity = (data) => api.post(`/api/activities`, data);
// ...
```

Once a second service (e.g. `services/users.js`,
`services/notifications.js`) shows up, the same five wrappers get
re-written again. And again. Not worth the duplication.

### The factory: `lib/wx-mp-core/src/resource.js`

```js
const activities = createResource({
  http,
  basePath: '/api/activities',
  decorate,                        // (item) => decoratedItem
});
// → activities.list, .get, .create, .update, .remove, .custom
```

Conventions baked into the factory:

- list endpoint returns `{ <plural>: [...], ...pagination }` —
  factory decorates each item, passes other fields through
- get/create/update return `{ <singular>: {...} }` — factory unwraps
  and decorates the bare object
- remove returns whatever the backend returns — pass-through

Auto-derives `singular` from `plural` via a small rules table (plus
a hand-written irregulars dict for `activities` → `activity`,
`people` → `person`, etc.). Override via `singular: 'foo'` when the
auto-derived form is wrong.

`custom(method, suffix, data)` is the escape hatch — sub-resources
and non-CRUD verbs. Returns the raw response (no decoration, no
unwrap) by design. Non-CRUD verbs (e.g. `PATCH`) fall through to
`http.request({ method, url, data })`.

### What stayed in `services/activity.js`

Five things don't fit the pure-CRUD shape, so they remain as
explicit methods (now using the factory's `custom()` for ones that
operate under `/api/activities/:id`):

| Old | New | Why explicit |
|---|---|---|
| `getMyActivities()` | kept as-is | scoped list, different endpoint |
| `getActivityRegistrations(id)` | kept as-is | sub-resource GET |
| `getActivityParticipants(id)` | kept as-is | sub-resource GET |
| `getActivityMatches(id)` | kept as-is | sub-resource GET |
| `createRegistration(id, data)` | via `custom('POST', ...)` | sub-resource POST |
| `completeActivity(id, data)` | via `custom('POST', ...)` | sub-resource POST |
| `previewCompleteActivity(id, data)` | via `custom('POST', ...)` | sub-resource POST |
| `cancelRegistration(regId)` | kept as-is | cross-resource (`/api/registrations/:id`) |

### Caller updates

Two call sites used the renamed methods:

- `pages/index/index.js`: `getActivities(params)` → `list(params)`
- `pages/activity-detail/index.js`: `getActivity(id)` → `get(id)`

Response shapes are unchanged — `list()` returns
`{activities, next_cursor, has_more}` with each item decorated;
`get(id)` returns the unwrapped decorated activity. Verified with a
compat smoke test under Node.

### Verification (this repo)

- 34/34 factory assertions under Node (URL-routed stub http):
  - all CRUD verbs hit the right URL with the right body
  - decorate applied per item in list, per single in get/create/update
  - singular auto-derive works for activities/people/children/users/
    matches/boxes (incl. the `ies` → `y` rule and the `es` drop rule)
  - multi-key responses keep the wrapper shape
  - singular override + `unwrap: false` opt-outs work
  - custom() returns raw (no decorate), non-CRUD verbs go through
    http.request
- 6/6 services/activity.js shape compat assertions: list returns
  decorated array + pagination, get returns unwrapped decorated
  object, cancelRegistration returns raw `{ok}`.
- All 30+ .js files in `bmt-game-miniprogram/` still parse.

### Line-count delta (this repo)

| | Before | After |
|---|---|---|
| `services/activity.js` | 107 | 96 |
| `wx-mp-core/src/resource.js` | — | 192 |

Net is a wash for the one existing service, but the real win is
**future services**: adding `services/users.js` or
`services/notifications.js` is now ~15 lines of `createResource` +
a `decorate` function, vs. ~50+ lines of explicit CRUD wrappers.

### Phase 8b (deferred) — `createListController`

The lifecycle mixin candidate for `pages/index`,
`pages/my-registrations`, `pages/notifications`, etc. Higher impact
than Phase 8a (eliminates ~30 lines per list page) but higher risk —
WeChat's `Page({})` doesn't accept hooks, so the helper has to
inject `onLoad` / `onShow` / `onPullDownRefresh` / `onReachBottom`
via a mixin, which is fiddly to test without devtools.

Recommended order: roll Phase 8b in one page first as a probe,
verify the mixin doesn't conflict with the page's own lifecycle
methods, then expand.

## Open questions

- Should `wx-mp-core` expose its own TypeScript definitions? WeChat
  devtools' type checking is half-hearted; a `.d.ts` file in the
  submodule gives IDE users (VS Code) autocompletion without runtime
  cost. Probably yes once 1.0.
- Should we ship a `wx-mp-core.miniprogram_npm` build path? See
  Phase 6 — only if a second consumer shows up and the relative-path
  shape becomes a real friction point.
- Test harness: WeChat devtools has no first-class JS test runner for
  miniprograms. Until that changes, the test surface for this submodule
  is "open the consumer app and run the smoke flows above." For pure
  functions (e.g. `absUrl` URL normalisation) we can add Node tests
  under `test/` that run with `node --test`.
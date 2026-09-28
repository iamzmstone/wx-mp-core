# wx-mp-core

Generic building blocks for WeChat Mini Programs. Lives as a git
submodule at `lib/wx-mp-core/` (sibling of `lib/minweb/`).

## Why this exists

Each new MP project kept re-implementing the same handful of patterns
— JWT-aware HTTP wrapper, WeChat login handshake, lazy `getApp()`,
absUrl normalisation, design tokens — and kept hitting the same WeChat
platform pitfalls (privacy consent, chooseAvatar buttonId, `http://`
images in release). This submodule is the place to put those patterns
*once* and document the pitfalls alongside the code.

This repo (bmt-game) is the first consumer. Extracted from
`bmt-game-miniprogram/services/api.js` and `app.js` after several
months of field use.

## Modules

| Module | Status | Source |
|---|---|---|
| `src/http.js` | ✅ extracted | from `services/api.js` |
| `src/auth.js` | ✅ extracted | from `services/auth.js` (login + profile-setup handshake) |
| `src/bootstrap.js` | ✅ extracted | env-aware apiBase + privacy consent setup (from `app.js`) |
| `src/session.js` | ✅ extracted | token/userInfo persistence (cold-start hydration + write-through). Shared by `app.js`, `auth.js`, `http.js` |
| `src/resource.js` | ✅ extracted | REST CRUD factory: `createResource({http, basePath, decorate})` → list/get/create/update/remove + `custom()` escape hatch |
| `src/ui/tokens.wxss` | ⏳ planned | will extract the shared design language from `styles/common.wxss` |
| `src/helpers/login-gate.js` | ⏳ planned | the `requireLoginThen({afterLogin})` pattern (currently lives inside auth.js — split out if a 2nd consumer needs it without the rest of auth) |
| `src/helpers/pagination.js` | ⏳ planned | cursor-pagination + silent filter pattern |
| `src/helpers/empty-state.js` | ⏳ planned | empty-state copy + dual CTA pattern |

## Setup (for new consumer projects)

```bash
# 1. Add the submodule (replace <remote-url> with the actual repo)
git submodule add git@github.com:<org>/wx-mp-core.git lib/wx-mp-core
git submodule update --init --recursive

# 2. In the consumer's `app.js`, point globalData.apiBase at the right
#    host per envVersion. Pattern is documented in
#    `docs/app-js-bootstrap.md` (TODO once we extract it).
```

WeChat developer tools pick up files under `lib/wx-mp-core/` just like
any other local file — no build step, no `npm install`, no
`miniprogram_npm` packaging. The submodule is consumed by relative
require paths (see below).

> **IMPORTANT: `lib/` must live INSIDE the miniprogram root.**
> WeChat devtools only loads files under the directory containing
> `project.config.json` (the `miniprogramRoot`). `lib/wx-mp-core`
> placed one level up from the MP root produces `can not find module`
> errors at runtime, even though the same require path resolves
> cleanly under Node. We moved the directory to
> `bmt-game-miniprogram/lib/wx-mp-core/` to fix this.
>
> When this submodule grows to be consumed by multiple MPs, the
> sibling-of-repo-root layout becomes attractive again — at that
> point revisit this constraint (it's a WeChat MP runtime rule,
> not a fundamental limitation).

> **For consumers in this repo (bmt-game):** the actual require path
> depends on the file's depth under `bmt-game-miniprogram/`:
>
> ```js
> // app.js                                →  ./lib/wx-mp-core/src/http
> // services/*.js                         →  ../lib/wx-mp-core/src/http
> // pages/*/index.js                      →  ../../lib/wx-mp-core/src/http
> // pages/admin/admin-*\/index.js         →  ../../../lib/wx-mp-core/src/http
> ```
>
> Rule: a file at depth N under the MP root uses `../` × (N-1) plus
> `lib/wx-mp-core/src/http`. `app.js` is depth 1, `services/*.js`
> are depth 2, etc. Don't assume `services/` is "level 1" — it's
> inside the MP root, so files in it are depth 2.
>
> WeChat devtools do **not** resolve bare module names without a
> `paths` mapping or a `miniprogram_npm` build. The relative path is
> the zero-config option. See `MIGRATION.md` Phase 6 for the
> npm-style alternative.

## Usage

The examples below use the bare-name form `wx-mp-core/src/http` for
readability. From bmt-game-miniprogram, the actual require depth
varies (see the callout above).

### HTTP wrapper

```js
// Singleton — reads apiBase/token from getApp().globalData (matches
// the legacy services/api.js shape, so swap-in is mechanical).
const api = require('wx-mp-core/src/http').default;

await api.get('/api/users/me');
await api.post('/api/orders', { sku: 'abc' });

// Background call — suppress the generic error toast:
api.get('/api/notifications/unread-count', null, { silent: true });

// Upload (e.g. avatar):
const { url } = await api.upload('/api/upload/avatar', tempFilePath);

// Re-anchor a server-relative URL against the current apiBase:
const src = api.absUrl(user.avatar_url);
```

### HTTP wrapper (factory — when globalData isn't your model)

```js
const { createHttp } = require('wx-mp-core/src/http');

const api = createHttp({
  // Required: where to find the base URL and the bearer token.
  getApiBase: () => wx.getStorageSync('apiBase'),
  getToken:   () => wx.getStorageSync('token'),

  // Optional: what to do on 401.
  // Default: clear session + redirect to /pages/index/index?needLogin=true.
  onUnauthorized: ({ redirectUrl }) => {
    wx.removeStorageSync('token');
    wx.reLaunch({ url: '/pages/login/index' });
  },

  // Optional: pull a user-facing message out of a non-2xx body.
  // Default handles `{ error: { message } }` and `{ message }`.
  parseError: (body) => body?.error?.message,

  // Optional: how to surface an error. Default is wx.showToast.
  showError: (msg) => console.warn('[api]', msg),
});
```

### Auth + session factory

`createAuth({ http, endpoints, ... })` returns the standard login +
session API. Backed by the same HTTP wrapper above, so it inherits
the singleton + factory shape for free.

```js
const { createAuth } = require('wx-mp-core/src/auth');
const http = require('wx-mp-core/src/http').default;

const auth = createAuth({
  http,
  endpoints: {
    // Required:
    login: '/api/auth/wechat',
    profileSetup: '/api/auth/wechat/complete-profile',
    // Optional — each enables the corresponding method:
    avatarUpload: '/api/upload/avatar',
    currentUser: '/api/users/me',
    updateProfile: '/api/users/me',
    deactivate: '/api/users/me/deactivate',
  },

  // Page to navigate to on new-user detection. Default:
  //   '/pages/profile-completion/index'
  profileCompletionPath: '/pages/profile-completion/index',

  // Optional: override session storage (defaults to getApp().globalData).
  // Useful when globalData isn't your model (e.g. tests, plugin mode).
  // getToken: () => wx.getStorageSync('token'),
  // setToken: (t) => wx.setStorageSync('token', t),
  // ...

  // Optional: override backend response envelope parsing.
  // parseLoginResponse: (body) => ({ ... }),
  // parseProfileSetupResponse: (body) => ({ ... }),

  // Optional: override default UX.
  // onPrivacyError: (err) => { /* default: show a modal */ },
  // onLoginFailure: (err) => { /* default: show a "登录失败" toast */ },
});

// Login flow (returns a user object, or { needProfileSetup, ... }):
await auth.wechatLogin();

// Or the login-gate (auto-navigates to profile-completion for new users):
await auth.requireLoginThen({ afterLogin: '/pages/X/index' });

// After first-login, complete the profile-setup handshake:
await auth.completeProfile({ tempToken, avatarUrl, nickname, gender });

// Profile editing (requires endpoints.updateProfile):
await auth.updateProfile({ username: 'foo' });

// Current user from server (requires endpoints.currentUser):
const fresh = await auth.fetchCurrentUser();
```

All 11 methods (`wechatLogin`, `completeProfile`, `checkSession`,
`getCurrentUser`, `isLoggedIn`, `logout`, `fetchCurrentUser`,
`updateProfile`, `uploadAvatar`, `deactivateAccount`,
`requireLoginThen`) match the legacy `services/auth.js` API, so
existing callers don't change when you swap the require path.

### App.js bootstrap helpers

`resolveApiBase` and `setupPrivacyConsent` are the two pieces of
`app.js` boilerplate that are identical across all WeChat MPs.

```js
const { resolveApiBase, setupPrivacyConsent } = require('wx-mp-core/src/bootstrap');

App({
  globalData: {
    apiBase: 'https://api.example.com',   // release default
    userInfo: null,
    token: null,
  },
  onLaunch() {
    // Pick the right backend host per envVersion.
    this.globalData.apiBase = resolveApiBase({
      develop: 'http://127.0.0.1:8888',
      trial:   'https://staging.example.com',
      release: 'https://api.example.com',
    }, 'https://api.example.com');

    // Log privacy state; rely on WeChat's built-in consent UI.
    setupPrivacyConsent();

    // ...restore session from storage, etc.
  },
});
```

Trial/release hosts must be added to the MP console's "request 合法域名"
list (no port allowed in release builds). The develop host
(`127.0.0.1`) is only used by devtools preview and doesn't need to
be added.

### Session persistence

`session.js` is the single source of truth for token + userInfo
persistence. Three layers typically touch session state:

- `app.js` (cold start: hydrate from storage; logout: clear both)
- `auth.js` (login: write token+user; logout: clear both)
- `http.js` (each request: read token to build Authorization header)

Without a shared module, each layer ends up duplicating the
`wx.setStorageSync` + `globalData.token = ...` write-through pattern,
and any layer that forgets one half leaves the two out of sync
(classic symptom: `app.globalData.token = null` but storage still has
a stale token, so the next cold start boots back into a logged-out
UI while the http wrapper still attaches an old Bearer token).

```js
const session = require('wx-mp-core/src/session');

App({
  onLaunch() {
    session.bootstrap();            // hydrate globalData from storage
  },
  setToken(t)      { session.writeToken(t);   this.refreshUnreadCount(); },
  setUserInfo(u)   { session.writeUser(u); },
  clearSession()   { session.clear();         this.globalData.unreadCount = 0; },
});
```

`http.js`'s default singleton and `auth.js`'s default session
accessors both read from / write to this module — consumers don't
have to wire anything up. Override per-instance (e.g. tests, plugin
mode) by passing `getToken` / `setToken` etc. to the factories.

### REST resource factory

`createResource({ http, basePath, decorate, ... })` generates the
five standard CRUD wrappers (`list`, `get`, `create`, `update`,
`remove`) for a backend resource, plus a `custom()` escape hatch
for sub-resources and non-CRUD endpoints.

```js
const { createResource } = require('wx-mp-core/src/resource');
const http = require('wx-mp-core/src/http').default;

const activities = createResource({
  http,
  basePath: '/api/activities',
  decorate: (a) => ({
    ...a,
    status_text: STATUS_TEXT[a.status],
    start_time_text: formatTime(a.start_time),
  }),
});

// Pure CRUD — list/get/create/update/remove.
//   list(params) → { activities: [...decorated], next_cursor, has_more }
//   get(id)       → { id, status_text, ... }  (auto-unwrapped from {activity: ...})
//   create(data)  → {...decorated}  (auto-unwrapped)
//   update(id)    → {...decorated}
//   remove(id)    → {}  (204-style, raw)
//
// list/get/create/update pass each item through `decorate`. Pagination
// fields (next_cursor, has_more, total_count) pass through unchanged.

module.exports = Object.assign({}, activities, {
  // Sub-resource writes — go through custom() (raw, no decorate)
  createRegistration(activityId, data) {
    return activities.custom('POST', `${activityId}/registrations`, data);
  },
  completeActivity(id, data) {
    return activities.custom('POST', `${id}/complete`, data);
  },
  // Cross-resource write — different basePath, call directly
  cancelRegistration(registrationId) {
    return api.del(`/api/registrations/${registrationId}`);
  },
});
```

Conventions the factory assumes (override via `singular`, `plural`,
or `unwrap` if your backend differs):

| Endpoint | Response shape | Factory behaviour |
|---|---|---|
| `list` | `{ <plural>: [...], ...pagination }` | decorate each item, leave other fields alone |
| `get` / `create` / `update` | `{ <singular>: {...} }` | unwrap + decorate the single object |
| `remove` | `{...}` or empty | pass through unchanged |

Singular is auto-derived from the plural (irregulars + 'ies'→'y' +
'es'→drop rules); override via `singular: 'foo'` when the
auto-derived form is wrong for your resource name.

`custom()` is the escape hatch for sub-resources and non-CRUD verbs.
It returns the raw response — no auto-decoration, no auto-unwrap.
Verbs other than GET/POST/PUT/DELETE fall through to `http.request()`.

Before / after in bmt-game's `services/activity.js`:

- 11 explicit functions → 5 inherited from factory + 8 explicit for
  sub-resources / custom verbs. Net: 107 → 96 lines, but the surface
  for **future** services (`users`, `registrations`, `notifications`,
  ...) drops from ~50 lines per service to ~15.

## 踩坑记录 (pitfalls worth not re-learning)

### 1. `getApp()` must be called lazily

When `services/api.js` is `require`d from `app.js`'s `onLaunch`, App()
has not been registered yet, so a top-level `getApp()` returns
undefined. Read `getApp()` *inside* the request callback, at call time,
not at module load time. Both `http.js` and the legacy
`services/api.js` do this — don't refactor it back into a top-level
constant.

### 2. WeChat rejects non-HTTPS image URLs in release

`<image src="http://example.com/foo.png">` works in devtools but
silently fails in release builds. `http.absUrl()` upgrades `http://`
→ `https://` so callers don't have to remember. Use it for every
`<image>` source that came from the backend.

### 3. Privacy consent (base lib 3.0.0+, especially 3.16.x)

The踩坑 is real for `wx.showModal` inside the custom handler: it does
**not** pause the flow on base lib 3.16.x — `chooseAvatar` fails with
"privacy permission is not authorized" before the user can tap. The
specific base-lib issue list:

- `wx.showModal` inside the handler does not actually pause the flow:
  `chooseAvatar` fails with "privacy permission is not authorized"
  *before* the user can tap anything.
- `wx.openPrivacyContract` navigates to a new page, which invalidates
  the `<button open-type="chooseAvatar">`'s `buttonId`. Even after the
  user agrees in the contract view, `chooseAvatar` still fails with
  "or buttonId is wrong".

**Workaround** (used by showme-photos): register the handler, but use
a **real WXML page** (via `wx.navigateTo`) instead of `wx.showModal`.
`wx.navigateTo` does pause the calling context, so the user actually
gets to read the policy and tap a button. The trade-off:

- The original privacy-sensitive API (e.g. `chooseAvatar`) still
  resolves with `disagree` and fails — the user retries after
  tapping "同意" in the consent page.
- This is审-friendly (the policy is visibly shown, the user explicitly
  chooses) and works on 3.4.6+ — the踩坑 only applies to `wx.showModal`.

The consumer is expected to provide the consent page; the bootstrap
helper takes an optional `consentPath` argument (default
`/pages/privacy/index`) so it can navigate there. The page itself
writes `{agreed: true, accepted_at: ISO}` to `wx.storage` under
`privacy_consent_v1`; the handler reads from there.

Don't open `wx.openPrivacyContract` inline from the consent page
either — also invalidates `buttonId`. Keep the policy text **inline**
in the WXML.

WeChat's built-in consent dialog runs in the same page context and
doesn't have either problem. The only requirement is that the privacy
contract is set up in the MP console. **Don't register a custom
handler that uses `wx.showModal`** — use a page instead, on any base
lib.

A minimal diagnostic for silent picker failures:

```js
wx.getPrivacySetting({
  success: (res) => console.log('[privacy] getPrivacySetting', res),
});
```

### 4. `chooseAvatar` buttonId validation

`<button open-type="chooseAvatar" bindchooseavatar="onChooseAvatar">`
has a per-page `buttonId` that's validated when the picker opens.
Any page navigation between the button render and the user tap can
invalidate it. If you see "or buttonId is wrong" in production logs
without a captured UI, suspect:
- a `wx.navigateTo` triggered by a sibling control on the same page
- a `wx.reLaunch` from a global error handler
- the privacy contract view (see #3)

### 5. WeChat pickers occasionally return non-zero-padded dates

`<picker mode="date" fields="month">` returns `"YYYY-MM"` *most* of
the time, but some base lib versions return `"YYYY-M"` for
single-digit months. Always normalise:

```js
const parts = v.split('-');
const normalized = (parts.length === 2)
  ? `${parts[0]}-${parts[1].padStart(2, '0')}`
  : v;
```

### 6. 401 handling must clear local session

A stale `token` in `wx.storage` will keep failing requests with 401
forever. Default `onUnauthorized` clears session + redirects to home;
the caller gets `Error('Unauthorized')` so it can bail without
surfacing a "网络请求失败" toast on top of the redirect.

### 7. `wx.uploadFile` returns a *string*, not parsed JSON

`success(res)` gives you `res.data === '{"url":"..."}'`. Parse it
yourself, or you'll spend an afternoon staring at `undefined`.

## Versioning

Pre-1.0; expect breaking changes as we extract `auth.js` and friends.
Once the consumer base grows past bmt-game, we cut 1.0 and lock the
per-module surface.

## Contributing from this repo (bmt-game)

To add a fix or new module:

1. Edit `lib/wx-mp-core/...` in place.
2. Commit on the wx-mp-core submodule branch.
3. Push to the wx-mp-core remote.
4. In this repo, bump the submodule pointer: `git add lib/wx-mp-core`.
5. In the consumer's `bmt-game-miniprogram/`, only change the require
   path once you're ready to consume the new module — see
   `MIGRATION.md`.

See `MIGRATION.md` for the step-by-step plan to roll this submodule
into bmt-game.
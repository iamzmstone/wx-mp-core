/**
 * wx-mp-core/session.js
 *
 * Single source of truth for the user's session: token + userInfo,
 * plus a scratch slot for `afterLogin` (used by auth.requireLoginThen
 * to remember where to go after profile-completion).
 *
 * Two storage layers, one module:
 *
 *   1. wx.storage (the durable layer) — survives cold start, used
 *      by session.bootstrap() on app launch.
 *   2. getApp().globalData (the cache) — fast in-memory reads, used
 *      by every getToken()/getUser() call afterwards.
 *
 * Writes go through BOTH layers (write-through); reads only hit the
 * cache (assumes bootstrap has run).
 *
 * Why one module instead of letting each consumer reach into
 * globalData + storage itself:
 *
 *   - One place to add a new key (e.g. refresh_token, last_seen_at).
 *   - One place to handle storage failures (try/catch around each
 *     wx.* call so a quota error doesn't crash the app).
 *   - One place to log session transitions when debugging.
 *   - The auth factory, the http wrapper, and app.js can share the
 *     same accessors instead of duplicating lazy-getApp() defaults.
 *
 * Usage from app.js (cold start):
 *
 *     App({
 *       globalData: { apiBase: '...', userInfo: null, token: null },
 *       onLaunch() {
 *         session.bootstrap();         // hydrate globalData from storage
 *         // ...
 *       },
 *       setToken(t)      { session.writeToken(t); this.refreshUnreadCount(); },
 *       setUserInfo(u)   { session.writeUser(u); },
 *       clearSession()   { session.clear(); },
 *     });
 *
 * Usage from auth.js / http.js (read accessors, can be passed as
 * default to the factories):
 *
 *     const session = require('wx-mp-core/src/session');
 *     const getToken = () => session.getToken();
 *     const setToken = (t) => session.writeToken(t);
 *
 * 踩坑记录:
 *   - `wx.setStorageSync` throws (rare, but happens on quota / private
 *     info rejection). Wrap each storage call in try/catch so a
 *     failed write doesn't break the in-memory cache (which is the
 *     layer every other read actually uses).
 *   - `getApp()` is null before App() registers. All accessors call
 *     it lazily inside the function, never at module load time.
 */

const KEY_TOKEN = 'token';
const KEY_USER = 'userInfo';
const KEY_AFTER_LOGIN = 'afterLogin';

function safeGetStorageSync(key) {
  try { return wx.getStorageSync(key); } catch (_) { return null; }
}
function safeSetStorageSync(key, val) {
  try { wx.setStorageSync(key, val); } catch (_) { /* quota / privacy reject — non-fatal */ }
}
function safeRemoveStorageSync(key) {
  try { wx.removeStorageSync(key); } catch (_) {}
}

function getGlobalData() {
  const app = typeof getApp === 'function' ? getApp() : null;
  return (app && app.globalData) || null;
}

/**
 * Hydrate globalData from storage. Call once from app.js's onLaunch.
 * Returns true if both token AND userInfo were present (i.e. the
 * user was already logged in when the app last closed).
 */
function bootstrap() {
  const gd = getGlobalData();
  if (!gd) return false;
  const token = safeGetStorageSync(KEY_TOKEN);
  const userInfo = safeGetStorageSync(KEY_USER);
  if (token && userInfo) {
    gd.token = token;
    gd.userInfo = userInfo;
    return true;
  }
  return false;
}

/**
 * Write-through: update globalData AND storage. Pass `null`/falsy
 * to clear both layers (e.g. on logout / session expiry).
 */
function writeToken(token) {
  const gd = getGlobalData();
  if (gd) gd.token = token;
  if (token) safeSetStorageSync(KEY_TOKEN, token);
  else safeRemoveStorageSync(KEY_TOKEN);
}

function writeUser(userInfo) {
  const gd = getGlobalData();
  if (gd) gd.userInfo = userInfo;
  if (userInfo) safeSetStorageSync(KEY_USER, userInfo);
  else safeRemoveStorageSync(KEY_USER);
}

/**
 * Clear both layers. Called by the 401 handler and by user-initiated
 * logout. Note: this does NOT touch `unreadCount` — that's an
 * app-level concern, not a session concern.
 */
function clear() {
  const gd = getGlobalData();
  if (gd) {
    gd.token = null;
    gd.userInfo = null;
  }
  safeRemoveStorageSync(KEY_TOKEN);
  safeRemoveStorageSync(KEY_USER);
}

// ---- Read accessors (cache-only) -----------------------------------------
//
// These read from globalData only. They assume bootstrap() has run.
// The auth factory and http wrapper use these as default session
// accessors — they don't need to wait for bootstrap because the
// factories themselves only read after a user action.

// getter functions let consumers use them as `getToken: () => session.getToken()`.

function getToken() {
  const gd = getGlobalData();
  return (gd && gd.token) || null;
}

function getUser() {
  const gd = getGlobalData();
  return (gd && gd.userInfo) || null;
}

// afterLogin is a scratch slot, not persisted to storage. The
// auth factory's requireLoginThen writes it before navigating to
// the profile-completion page; profile-completion reads it after
// submit to know where to redirect.
function getAfterLogin() {
  const gd = getGlobalData();
  return (gd && gd.afterLogin) || null;
}

function setAfterLogin(target) {
  const gd = getGlobalData();
  if (gd) gd.afterLogin = target;
}

module.exports = {
  bootstrap,
  writeToken,
  writeUser,
  clear,
  getToken,
  getUser,
  getAfterLogin,
  setAfterLogin,
};
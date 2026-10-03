/**
 * wx-mp-core/bootstrap.js
 *
 * Two pieces of `app.js` boilerplate that are identical across
 * WeChat Mini Programs:
 *
 *   1. resolveApiBase(envMap, fallback)
 *      — pick the right backend host per `envVersion`
 *        (develop / trial / release).
 *
 *   2. setupPrivacyConsent(logger)
 *      — log the privacy state. Intentionally does NOT register a custom
 *        `wx.onNeedPrivacyAuthorization` handler. WeChat's built-in
 *        consent dialog is the only thing that works reliably on
 *        base lib 3.16.x; the踩坑 details are in README.md.
 *
 * Both helpers are intentionally stateless (no shared state, no
 * side effects beyond the explicit ones listed below) so the
 * consumer's `app.js` stays in full control of `globalData`.
 */

/**
 * Resolve the right apiBase for the current build environment.
 *
 * Usage:
 *
 *     this.globalData.apiBase = resolveApiBase({
 *       develop: 'http://127.0.0.1:8888',
 *       trial:   'https://staging.example.com',
 *       release: 'https://api.example.com',
 *     }, 'https://api.example.com');   // fallback when envVersion is unknown
 *
 * Reads `envVersion` from `wx.getAccountInfoSync()`. If the API
 * throws (very old base libs), or `envVersion` is something other
 * than develop/trial/release, returns `fallback`.
 *
 * 踩坑记录 (carried over from bmt-game/app.js):
 *   - WeChat requires the trial/release host to be added to the MP
 *     console's "request 合法域名" list. No port is allowed in
 *     release builds. The develop host (127.0.0.1) is only used by
 *     devtools preview, so it doesn't need to be added.
 */
function resolveApiBase(envMap, fallback) {
  if (!envMap || typeof envMap !== 'object') {
    return fallback || '';
  }
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const env = info && info.miniProgram && info.miniProgram.envVersion;
    if (env && Object.prototype.hasOwnProperty.call(envMap, env)) {
      return envMap[env];
    }
  } catch (_) {
    // getAccountInfoSync unavailable — fall through to fallback.
  }
  return fallback || '';
}

/**
 * Log the current privacy state. Intentionally does NOT register a
 * custom `wx.onNeedPrivacyAuthorization` handler.
 *
 * 踩坑: the custom handler path is broken in base lib 3.16.x in two
 * specific ways (see README.md for the full list):
 *   - `wx.showModal` inside the callback doesn't actually pause the
 *     flow — `chooseAvatar` fails with "privacy permission is not
 *     authorized" before the user can tap anything.
 *   - `wx.openPrivacyContract` navigates to a new page, which
 *     invalidates the `<button open-type="chooseAvatar">`'s
 *     `buttonId`. Even after the user agrees in the contract view,
 *     `chooseAvatar` still fails with "or buttonId is wrong".
 *
 * WeChat's built-in consent dialog runs in the same page context
 * and does not have either problem. The only requirement is that
 * the privacy contract is set up in the MP console.
 *
 * `logger` defaults to `console`; pass a no-op logger in tests.
 */
function setupPrivacyConsent(logger) {
  const log = logger || console;
  try {
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: (res) => log.log('[privacy] getPrivacySetting', res),
        fail: (err) => log.warn('[privacy] getPrivacySetting failed', err),
      });
    }
    log.log('[privacy] using WeChat built-in consent UI (no custom handler)');
  } catch (e) {
    log.warn('[privacy] setupPrivacyConsent threw', e);
  }
}

module.exports = {
  resolveApiBase,
  setupPrivacyConsent,
};
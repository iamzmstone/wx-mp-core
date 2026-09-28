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
 *   2. setupPrivacyConsent(logger, consentPath?)
 *      — log the privacy state AND register a custom
 *        `wx.onNeedPrivacyAuthorization` handler that defers to the
 *        consumer's `wx.storage` consent record. The handler resolves
 *        `{event: 'agree'}` only when the user has previously tapped
 *        "agree" in the consent page; otherwise it routes to the
 *        consent page (a real WXML page, NOT `wx.showModal` — see
 *        README.md pitfall #3) and resolves `{event: 'disagree'}`.
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
 * The wx.storage key the consumer writes its consent record to. The
 * consumer (app.js + pages/privacy/index) is responsible for setting
 * this; the handler only reads it.
 */
const CONSENT_KEY = 'privacy_consent_v1';

/**
 * Default path to the consumer's consent page. Override via the
 * `consentPath` argument to setupPrivacyConsent if your project lays
 * the consent page elsewhere.
 */
const DEFAULT_CONSENT_PATH = '/pages/privacy/index';

/**
 * Log the current privacy state and register a custom
 * `wx.onNeedPrivacyAuthorization` handler.
 *
 * The handler does NOT block on user input — it only reads the existing
 * consent record and either resolves 'agree' (consented) or 'disagree'
 * (not consented, also navigates the user to the consent page so they
 * can opt in). Once the user agrees in the consent page and re-tries
 * the privacy-sensitive API (e.g. taps the chooseAvatar button again),
 * the handler will see the consent record and resolve 'agree'.
 *
 * Why this design (instead of `wx.showModal` inside the handler):
 *   - `wx.showModal` inside `onNeedPrivacyAuthorization` does not
 *     pause the flow on base lib 3.16.x: `chooseAvatar` fails with
 *     "privacy permission is not authorized" before the user can tap.
 *   - We use a real WXML page via `wx.navigateTo`, which DOES pause
 *     the current task context and gives the user time to read and
 *     decide. The trade-off is that the original API call still
 *     fails with `disagree`; the user retries after agreeing. This
 *     is审-friendly (visible, opt-in flow) and works on 3.4.6+ base
 *     libs (the踩坑 only applies to `wx.showModal`).
 *
 * `logger` defaults to `console`; pass a no-op logger in tests.
 */
function setupPrivacyConsent(logger, consentPath) {
  const log = logger || console;
  const consentPage = consentPath || DEFAULT_CONSENT_PATH;
  try {
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: (res) => log.log('[privacy] getPrivacySetting', res),
        fail: (err) => log.warn('[privacy] getPrivacySetting failed', err),
      });
    }
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization(({ event, resolve }) => {
        let c = null;
        try { c = wx.getStorageSync(CONSENT_KEY) || null; } catch (_) { c = null; }
        if (c && c.agreed === true) {
          resolve({ event: 'agree' });
          return;
        }
        // 没同意 → 跳同意页(用 navigateTo 而非 showModal,绕开踩坑)
        try {
          wx.navigateTo({
            url: consentPage + '?from=handler&force=1',
            fail: (err) => log.warn('[privacy] navigateTo consent page failed', err),
          });
        } catch (e) {
          log.warn('[privacy] navigateTo threw', e);
        }
        // 当前 API 调用仍以 'disagree' 失败;用户回到原页面后,
        // 重试触发 chooseAvatar 等,handler 看到同意状态 → resolve agree。
        resolve({ event: 'disagree' });
      });
      log.log('[privacy] registered onNeedPrivacyAuthorization handler');
    } else {
      log.log('[privacy] wx.onNeedPrivacyAuthorization unavailable (too old base lib)');
    }
  } catch (e) {
    log.warn('[privacy] setupPrivacyConsent threw', e);
  }
}

module.exports = {
  resolveApiBase,
  setupPrivacyConsent,
};
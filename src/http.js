/**
 * wx-mp-core/http.js
 *
 * Generic HTTP wrapper for WeChat Mini Programs.
 *
 * Two ways to use it:
 *
 *   1. Singleton (drop-in for the legacy `services/api.js` pattern):
 *
 *        const api = require('wx-mp-core/http').default;
 *        api.get('/api/users/me');
 *
 *      Reads `apiBase` and `token` from `getApp().globalData` lazily,
 *      so the same module works whether it's required at app startup
 *      (before App() is registered) or from a page.
 *
 *   2. Factory (when you want to inject config without globalData):
 *
 *        const { createHttp } = require('wx-mp-core/http');
 *        const api = createHttp({
 *          getApiBase: () => 'https://api.example.com',
 *          getToken:   () => wx.getStorageSync('token'),
 *          onUnauthorized: () => { … default behaviour shown below … },
 *          parseError: (body) => body?.error?.message,
 *        });
 *
 * Design notes / 踩坑记录:
 *   - `getApp()` MUST be called lazily inside the request body, not at
 *     module load time. When `services/api.js` is `require`d from
 *     `app.js`'s `onLaunch`, top-level `getApp()` returns undefined
 *     because App() hasn't been registered yet.
 *   - `absUrl` upgrades `http://` to `https://` for `<image>` sources
 *     — WeChat rejects non-HTTPS image URLs in release builds.
 *   - 401 handling calls `onUnauthorized` (default: clearSession +
 *     redirect) and rejects. Callers awaiting the promise get
 *     `Error('Unauthorized')` so they can bail cleanly.
 *   - `silent: true` on a request suppresses the generic error toast
 *     so background calls (badge refresh, list filters) don't intrude
 *     on the user. Caller decides what to do via .catch().
 */

const session = require('./session');

const DEFAULTS = {
  getApiBase: () => '',
  // Static-asset base URL. Used by `absUrl` for paths starting with
  // `/static/` (avatars, OSS-served photos mirrored locally, etc.).
  // Defaults to apiBase — same backend serves API + static in this
  // project — but can be overridden in the consumer's app.js (e.g.
  // point at a CDN without touching every call site).
  getStaticBase: null,
  getToken: () => null,

  // Called on 401. Receives { redirectUrl } so the consumer can decide
  // whether to actually navigate (some apps want to just clear and
  // stay on the current page).
  onUnauthorized: ({ redirectUrl }) => {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.clearSession === 'function') app.clearSession();
    if (redirectUrl && typeof wx !== 'undefined' && wx.redirectTo) {
      wx.redirectTo({ url: redirectUrl });
    }
  },

  // Pull a user-facing error message out of a non-2xx response body.
  // The default handles the most common shape: `{ error: { message } }`
  // or a flat `{ message }`. Override for backends that differ.
  parseError: (body) => {
    if (!body) return null;
    if (typeof body === 'string') return body;
    return body.error?.message || body.message || null;
  },

  // How to surface an error to the user. Defaults to a non-blocking
  // wx.showToast. Override for silent / modal / log-only flows.
  showError: (message) => {
    if (typeof wx !== 'undefined' && wx.showToast) {
      wx.showToast({ title: message, icon: 'none' });
    }
  },

  defaultErrorMessage: '请求失败',
  defaultNetworkErrorMessage: '网络请求失败',
  unauthorizedRedirectUrl: '/pages/index/index?needLogin=true',
};

function mergeOptions(userOptions) {
  // Shallow merge: userOptions wins, but undefined keys fall through to defaults.
  const out = Object.assign({}, DEFAULTS, userOptions || {});
  // Allow partial overrides of nested option objects via spread.
  if (userOptions && userOptions.headerDefaults) {
    out.headerDefaults = Object.assign(
      {},
      DEFAULTS.headerDefaults || {},
      userOptions.headerDefaults
    );
  }
  return out;
}

function createHttp(userOptions) {
  const opts = mergeOptions(userOptions);

  function request(options) {
    // Lazy getApp() — this module may be required from app.js's onLaunch,
    // before App() is fully registered, in which case top-level getApp()
    // returns undefined. Reading here, at call time, sidesteps the race.
    const apiBase = opts.getApiBase();
    const token = opts.getToken();
    // Background calls (silent: true) suppress the generic error toast
    // so a stray failure on the home page or badge refresh doesn't
    // intrude on the user. Callers handle the error themselves via
    // .catch().
    const silent = !!options.silent;

    return new Promise((resolve, reject) => {
      wx.request({
        url: apiBase + options.url,
        method: options.method || 'GET',
        data: options.data,
        header: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
          ...(options.header || {}),
        },
        success(res) {
          if (res.statusCode === 401) {
            opts.onUnauthorized({ redirectUrl: opts.unauthorizedRedirectUrl });
            reject(new Error('Unauthorized'));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data);
          } else {
            const message =
              opts.parseError(res.data) || opts.defaultErrorMessage;
            if (!silent) opts.showError(message);
            reject(res.data);
          }
        },
        fail(err) {
          if (!silent) opts.showError(opts.defaultNetworkErrorMessage);
          reject(err);
        },
      });
    });
  }

  function get(url, data, options) {
    return request({ url, method: 'GET', data, ...(options || {}) });
  }
  function post(url, data, options) {
    return request({ url, method: 'POST', data, ...(options || {}) });
  }
  function put(url, data, options) {
    return request({ url, method: 'PUT', data, ...(options || {}) });
  }
  function del(url, data, options) {
    return request({ url, method: 'DELETE', data, ...(options || {}) });
  }

  /**
   * Upload a local file (e.g. a chooseAvatar temp file) as multipart/form-data.
   * Resolves with the parsed JSON body; wx.uploadFile hands back a raw string.
   *
   * Optional 4th arg `options.token` overrides the default session token —
   * used by first-login flows to authenticate with a temp token before
   * the user has a session.
   */
  function upload(url, filePath, name = 'file', uploadOptions) {
    const uo = uploadOptions || {};
    return new Promise((resolve, reject) => {
      const apiBase = opts.getApiBase();
      const token = uo.token || opts.getToken();

      wx.uploadFile({
        url: apiBase + url,
        filePath,
        name,
        formData: uo.formData || {},
        header: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
        success(res) {
          let body;
          try {
            body = JSON.parse(res.data);
          } catch (_) {
            reject(new Error('上传响应解析失败'));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            // Match the legacy behaviour: no toast on upload failure —
            // callers (auth.completeProfile) own the user-facing message.
            reject(body);
          }
        },
        fail: reject,
      });
    });
  }

  /**
   * Resolve a server-relative path (e.g. "/static/uploads/...") against
   * the current apiBase (or staticBase for `/static/*` paths). Absolute
   * URLs pass through, except for two legacy cases we normalise so
   * <image> doesn't fail in release builds:
   *   1. http:// — WeChat rejects non-HTTPS in production.
   *   2. http(s)://127.0.0.1[:port] — older dev uploads stored an
   *      absolute dev URL in the DB; re-anchor on the current apiBase.
   *
   * `/static/*` is treated specially: it's served from the same backend
   * as the API in this project, but `getStaticBase` lets the consumer
   * point at a CDN independently. `getStaticBase` defaults to apiBase.
   */
  function absUrl(path) {
    if (!path) return '';
    const apiBase = opts.getApiBase();
    const staticBase = opts.getStaticBase ? opts.getStaticBase() : apiBase;
    if (/^https?:\/\//.test(path)) {
      return path
        .replace(/^https?:\/\/127\.0\.0\.1(:\d+)?/, apiBase)
        .replace(/^http:\/\//, 'https://');
    }
    // /static/* uses staticBase; everything else uses apiBase.
    if (path.charCodeAt(0) === 47 /* '/' */ && path.startsWith('/static/')) {
      return staticBase + path;
    }
    return apiBase + path;
  }

  return {
    request,
    get,
    post,
    put,
    delete: del,
    del,
    upload,
    absUrl,
  };
}

// ---- Default singleton ---------------------------------------------------
//
// Reads `apiBase` and `token` from `getApp().globalData` lazily. This
// matches the legacy `services/api.js` shape so existing consumers can
// swap the require path with no further changes:
//
//     // before
//     const api = require('./lib/wx-mp-core/src/http').default;
//     // after
//     const api = require('wx-mp-core/http').default;
//     // api.get(...) still works the same way

const defaultHttp = createHttp({
  getApiBase: () => {
    // apiBase is a config concern, not a session concern — set by
    // bootstrap.resolveApiBase() in app.js's onLaunch.
    const app = typeof getApp === 'function' ? getApp() : null;
    return (app && app.globalData && app.globalData.apiBase) || '';
  },
  // staticBaseUrl defaults to apiBase. Apps that front the static dir
  // with a CDN can set app.globalData.staticBaseUrl in onLaunch to
  // override. absUrl uses this only for paths starting with `/static/`.
  getStaticBase: () => {
    const app = typeof getApp === 'function' ? getApp() : null;
    const gd = app && app.globalData;
    return (gd && gd.staticBaseUrl) || (gd && gd.apiBase) || '';
  },
  // Delegate token reads to the shared session module so the auth
  // factory and the http wrapper always see the same source.
  getToken: session.getToken,
});

module.exports = {
  createHttp,
  defaultHttp,
  // Convenience alias matching the legacy module's default export shape.
  default: defaultHttp,
};
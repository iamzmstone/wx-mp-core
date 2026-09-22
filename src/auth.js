/**
 * wx-mp-core/auth.js
 *
 * Generic WeChat login + session factory. Built on top of a configured
 * HTTP instance from http.js; talks to your backend's wechat-login
 * endpoint and a profile-setup handshake (if your backend uses one).
 *
 * Usage (drop-in for bmt-game's services/auth.js shape):
 *
 *     const { createAuth } = require('wx-mp-core/src/auth');
 *     const http = require('wx-mp-core/src/http').default;
 *
 *     const auth = createAuth({
 *       http,
 *       endpoints: {
 *         login: '/api/auth/wechat',
 *         profileSetup: '/api/auth/wechat/complete-profile',
 *         avatarUpload: '/api/upload/avatar',
 *         currentUser: '/api/users/me',
 *         updateProfile: '/api/users/me',
 *         deactivate: '/api/users/me/deactivate',
 *       },
 *       profileCompletionPath: '/pages/profile-completion/index',
 *     });
 *
 *     auth.wechatLogin();                // -> user object, or
 *                                          //    { needProfileSetup, openid, tempToken }
 *     auth.requireLoginThen({ afterLogin: '/pages/X/index' });
 *     auth.updateProfile({ nickname: 'foo' });
 *
 * 踩坑记录 (carried over from the bmt-game extraction):
 *   - `wx.login` may reject with errMsg containing "privacy" when the
 *     user declines the privacy contract. Default `onPrivacyError`
 *     surfaces a friendlier modal than the generic "登录失败" toast.
 *   - `requireLoginThen` swallows login errors silently by default
 *     (calls wechatLogin with `silent: true`). Page-level callers
 *     that genuinely care about the failure should call
 *     `auth.wechatLogin({ silent: false })` directly so the toast
 *     surfaces.
 *   - `getApp()` MUST be called lazily inside the storage accessors,
 *     not at module load time. Same reason as http.js — App() is not
 *     registered yet during app.js's onLaunch.
 */

const session = require('./session');

function createAuth(userOptions) {
  if (!userOptions || !userOptions.http) {
    throw new Error(
      'createAuth requires { http } — pass a configured HTTP instance from wx-mp-core/http'
    );
  }
  if (!userOptions.endpoints || !userOptions.endpoints.login) {
    throw new Error('createAuth requires endpoints.login');
  }
  if (!userOptions.endpoints.profileSetup) {
    throw new Error('createAuth requires endpoints.profileSetup');
  }

  const opts = {
    http: userOptions.http,
    endpoints: Object.assign(
      {
        avatarUpload: null,
        currentUser: null,
        updateProfile: null,
        deactivate: null,
      },
      userOptions.endpoints
    ),
    session: {
      // All seven defaults delegate to session.js — the same module
      // app.js uses for cold-start hydration + write-through. Override
      // per-instance if your consumer stores session state outside
      // getApp().globalData (e.g. tests, plugin mode).
      getToken: userOptions.getToken || session.getToken,
      setToken: userOptions.setToken || session.writeToken,
      getUser: userOptions.getUser || session.getUser,
      setUser: userOptions.setUser || session.writeUser,
      clearSession: userOptions.clearSession || session.clear,
      getAfterLogin: userOptions.getAfterLogin || session.getAfterLogin,
      setAfterLogin: userOptions.setAfterLogin || session.setAfterLogin,
    },
    parseLogin: userOptions.parseLoginResponse || defaultParseLoginResponse,
    parseProfileSetup:
      userOptions.parseProfileSetupResponse || defaultParseProfileSetupResponse,
    profileCompletionPath:
      userOptions.profileCompletionPath || '/pages/profile-completion/index',
    onPrivacyError: userOptions.onPrivacyError || defaultOnPrivacyError,
    onLoginFailure: userOptions.onLoginFailure || defaultLoginFailure,
  };

  /**
   * Step 1 of the wechat-login handshake: call wx.login() to get a code,
   * then POST it to endpoints.login. The backend resolves to either
   * an existing user (full session) or a need-profile-setup signal
   * (new user must complete onboarding before any token is issued).
   *
   * silent: true suppresses the generic "登录失败" toast so background
   * calls (badge refresh, list filters) don't intrude on the user.
   */
  function wechatLogin(loginOptions) {
    const lo = loginOptions || {};
    const silent = !!lo.silent;
    return new Promise((resolve, reject) => {
      wx.login({
        success(res) {
          if (!res.code) {
            reject(new Error('Failed to get code'));
            return;
          }
          opts.http
            .post(opts.endpoints.login, { code: res.code }, { silent })
            .then(body => {
              const parsed = opts.parseLogin(body);
              if (parsed.needsProfileSetup) {
                // New user — leave token unset and hand back the setup
                // handshake so the caller can route to profile-completion.
                resolve({
                  needProfileSetup: true,
                  openid: parsed.openid,
                  tempToken: parsed.tempToken,
                });
                return;
              }
              opts.session.setToken(parsed.token);
              opts.session.setUser(parsed.user);
              resolve(parsed.user);
            })
            .catch(err => {
              const msg = (err && err.errMsg) || '';
              // WeChat returns errMsg containing "privacy" when the user
              // rejected the privacy contract — surface a friendlier hint
              // than the generic "登录失败".
              if (msg.toLowerCase().includes('privacy')) {
                opts.onPrivacyError(err);
              } else if (!silent) {
                opts.onLoginFailure(err);
              }
              reject(err);
            });
        },
        fail(err) {
          reject(err);
        },
      });
    });
  }

  /**
   * Step 2 of the wechat-login handshake: upload the avatar picked
   * via chooseAvatar, then POST the rest of the profile fields to
   * endpoints.profileSetup using the temp token issued in step 1.
   * Resolves with the new user object; backend also returns a real
   * session token that we install via setToken.
   */
  async function completeProfile({ tempToken, avatarUrl, nickname, gender }) {
    if (!opts.endpoints.avatarUpload) {
      throw new Error(
        'createAuth: endpoints.avatarUpload is required for completeProfile'
      );
    }
    const uploadRes = await opts.http.upload(
      opts.endpoints.avatarUpload,
      avatarUrl,
      'file',
      { token: tempToken }
    );
    const avatar_url = uploadRes && uploadRes.url;
    if (!avatar_url) {
      throw new Error('头像上传失败');
    }
    const body = await opts.http.post(
      opts.endpoints.profileSetup,
      { avatar_url, nickname, gender },
      { header: { Authorization: `Bearer ${tempToken}` } }
    );
    const { user, token } = opts.parseProfileSetup(body);
    opts.session.setToken(token);
    opts.session.setUser(user);
    return user;
  }

  /**
   * Wraps wx.checkSession. On session expiry, clears the local
   * session so the next request triggers a fresh login.
   */
  function checkSession() {
    return new Promise(resolve => {
      wx.checkSession({
        success: () => resolve(true),
        fail: () => {
          opts.session.clearSession();
          resolve(false);
        },
      });
    });
  }

  function getCurrentUser() {
    return opts.session.getUser();
  }

  function isLoggedIn() {
    return !!opts.session.getToken();
  }

  function logout() {
    opts.session.clearSession();
  }

  /**
   * Fetch the current user from the backend and cache it locally.
   * Useful when the cached userInfo only carries a few fields (e.g.
   * just id+username+role after wechatLogin) and the page needs
   * the full profile (avatar_url, gender, etc.).
   */
  async function fetchCurrentUser() {
    if (!opts.endpoints.currentUser) {
      throw new Error(
        'createAuth: endpoints.currentUser is required for fetchCurrentUser'
      );
    }
    const u = await opts.http.get(opts.endpoints.currentUser);
    opts.session.setUser(u);
    return u;
  }

  async function updateProfile(data) {
    if (!opts.endpoints.updateProfile) {
      throw new Error(
        'createAuth: endpoints.updateProfile is required for updateProfile'
      );
    }
    const u = await opts.http.put(opts.endpoints.updateProfile, data);
    opts.session.setUser(u);
    return u;
  }

  /**
   * Upload a chooseAvatar temp file; resolves with the server-relative URL.
   * Uses the regular session token by default.
   */
  async function uploadAvatar(filePath) {
    if (!opts.endpoints.avatarUpload) {
      throw new Error(
        'createAuth: endpoints.avatarUpload is required for uploadAvatar'
      );
    }
    const res = await opts.http.upload(opts.endpoints.avatarUpload, filePath);
    return res.url;
  }

  /**
   * Soft-delete the current account. Backend sets user/status to disabled;
   * the next login attempt is rejected. Existing JWT is not invalidated
   * mid-session, so callers should clear local state after success.
   */
  async function deactivateAccount() {
    if (!opts.endpoints.deactivate) {
      throw new Error(
        'createAuth: endpoints.deactivate is required for deactivateAccount'
      );
    }
    return opts.http.post(opts.endpoints.deactivate);
  }

  /**
   * Gate a flow on WeChat login.
   *
   * Returns the user object when login is satisfied (already logged in,
   * or wechatLogin() succeeded with an existing session). If the user
   * is brand new (need_profile_setup handshake), saves
   * `options.afterLogin` for profile-completion to read after submit,
   * navigates to the profile setup page, and returns null so the
   * caller can bail.
   *
   * Options:
   *   afterLogin  String  Page path to return to after profile completion.
   *                       Defaults to whatever profile-completion picks
   *                       (no value persisted means profile-completion
   *                        falls back to its own default).
   */
  async function requireLoginThen(loginOptions) {
    const lo = loginOptions || {};
    if (isLoggedIn()) return getCurrentUser();
    // Login was triggered implicitly by the caller opening a gated page —
    // suppress the "登录失败" toast so failures don't intrude. Pages that
    // genuinely care about the failure should call wechatLogin() directly
    // with silent: false.
    const result = await wechatLogin({ silent: true });
    if (result && result.needProfileSetup) {
      if (lo.afterLogin) opts.session.setAfterLogin(lo.afterLogin);
      const sep = opts.profileCompletionPath.includes('?') ? '&' : '?';
      const url =
        opts.profileCompletionPath +
        sep +
        'mode=first-login&tempToken=' +
        encodeURIComponent(result.tempToken);
      wx.navigateTo({ url });
      return null;
    }
    return result;
  }

  return {
    wechatLogin,
    completeProfile,
    checkSession,
    getCurrentUser,
    isLoggedIn,
    logout,
    fetchCurrentUser,
    updateProfile,
    uploadAvatar,
    deactivateAccount,
    requireLoginThen,
  };
}

// ---- Default session storage accessors ----------------------------------
//
// All seven defaults delegate to ./session — the same module app.js
// uses for cold-start hydration (`session.bootstrap()`) and for
// write-through persistence. See session.js for the storage +
// globalData layering details.
//
// 踩坑: previous shape of these defaults only wrote to globalData,
// not storage. That worked because app.js's setToken/setUserInfo
// did the storage write themselves. Now that session.writeToken
// does both, the auth factory and app.js share one source of truth
// and there's no risk of the two falling out of sync.

// ---- Default backend response parsers ------------------------------------
//
// These handle the most common shape: backend returns
// `{ user, token, need_profile_setup?, temp_token?, openid? }`.
// Override via `parseLoginResponse` / `parseProfileSetupResponse`
// if your backend uses a different envelope.

function defaultParseLoginResponse(body) {
  return {
    user: body.user,
    token: body.token,
    needsProfileSetup: !!body.need_profile_setup,
    tempToken: body.temp_token,
    openid: body.openid,
  };
}

function defaultParseProfileSetupResponse(body) {
  return { user: body.user, token: body.token };
}

// ---- Default UX hooks ----------------------------------------------------

function defaultOnPrivacyError() {
  wx.showModal({
    title: '需要同意隐私协议',
    content: '请在弹窗中同意《用户隐私协议》后再登录。',
    showCancel: false,
    confirmText: '我知道了',
  });
}

function defaultLoginFailure() {
  wx.showToast({ title: '登录失败', icon: 'none' });
}

module.exports = { createAuth };
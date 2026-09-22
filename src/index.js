/**
 * wx-mp-core — main entry.
 *
 * Today: just the HTTP wrapper.
 * Tomorrow: auth.js, session.js, ui tokens, helpers (login-gate,
 * pagination, empty-state), app.js bootstrap.
 *
 * Consumers should prefer the per-module entry when they only need one
 * piece (smaller require graph), and this barrel when they want the
 * convenience of one import.
 */

const http = require('./http');

module.exports = {
  http: http.defaultHttp,
  createHttp: http.createHttp,
  // Per-module exports — keep stable so consumers can deep-require
  // even after we add more modules.
  // e.g. require('wx-mp-core/src/auth').wechatLogin
};
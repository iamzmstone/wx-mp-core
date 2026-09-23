/**
 * wx-mp-core/resource.js
 *
 * Generic REST CRUD factory. Generate list/get/create/update/remove
 * for a backend resource without writing the same five thin wrappers
 * in every `services/X.js`.
 *
 * Usage:
 *
 *     const { createResource } = require('wx-mp-core/src/resource');
 *     const http = require('wx-mp-core/src/http').default;
 *
 *     const activities = createResource({
 *       http,
 *       basePath: '/api/activities',
 *       decorate: (a) => ({
 *         ...a,
 *         status_text: STATUS_TEXT[a.status],
 *         start_time_text: formatTime(a.start_time),
 *       }),
 *     });
 *
 *     const { activities: list, next_cursor, has_more } = await activities.list({
 *       status: 'published', limit: 20,
 *     });
 *     // list is the array; next_cursor and has_more pass through.
 *     // Each item ran through decorate().
 *
 *     const a = await activities.get(42);
 *     // a is the single object, decorated.
 *
 *     const created = await activities.create({ title: '...' });
 *     // created is the single object, decorated.
 *
 *     await activities.remove(42);
 *
 * For sub-resources and non-CRUD endpoints, use the escape hatch:
 *
 *     await activities.custom('POST', `${id}/registrations`, data);
 *     await activities.custom('POST', `${id}/preview-complete`, {...});
 *
 * Conventions (most backends match):
 *
 *   list endpoint returns `{ <plural>: [...], ...pagination }`
 *   get endpoint returns  `{ <singular>: {...} }`
 *
 * The factory wraps both: it locates the array field in the list
 * response and decorates each item, and unwraps the single-object
 * response from `{ <singular>: {...} }` to just `{...}`. Other
 * fields (next_cursor, has_more, total_count) pass through.
 *
 * Singular auto-derivation: derived from the plural via a small
 * rules table + irregulars dict. Override via `singular` if the
 * auto-derived form is wrong for your resource.
 *
 * 踩坑:
 *   - The "unwrap the single key" heuristic (response.length === 1
 *     && the key matches `singular`) assumes the backend returns
 *     exactly one top-level field. If your backend returns
 *     `{ activity: {...}, server_time: 12345 }`, decorateOneResponse
 *     will decorate `activity` and pass `server_time` through — but
 *     the unwrap-to-plain-object path won't fire (since keys.length
 *     is 2, not 1). Set `singular: null` to disable unwrapping and
 *     keep the wrapper shape.
 *   - `decorate` runs on each item. Heavy decoration (e.g.
 *     formatting big strings) is fine on a list of 20; for list
 *     pages > 100 items consider doing the decoration in the
 *     WXML instead.
 *   - `custom()` falls through to whatever HTTP method matches the
 *     string passed (GET/POST/PUT/DELETE → http.get/post/put/delete).
 *     Other verbs go through `http.request()`.
 *   - `list()` strips null/undefined/empty-string params before
 *     passing them to `http.get()`. WeChat's `wx.request` serializes
 *     `null` as `key=` (empty value) and `undefined` inconsistently
 *     across base lib versions, which some backends treat differently
 *     from "no param at all". This matches the hand-rolled URL
 *     building the consumer code used to do before the factory.
 *     Override via `cleanParams: false` if you want the raw params
 *     passed through.
 */

const SINGULAR_OVERRIDES = {
  activities: 'activity',
  people: 'person',
  children: 'child',
  data: 'data',
  criteria: 'criterion',
  analyses: 'analysis',
};

function deriveSingular(plural) {
  if (!plural) return '';
  if (SINGULAR_OVERRIDES[plural]) return SINGULAR_OVERRIDES[plural];
  if (plural.endsWith('ies') && plural.length > 3) return plural.slice(0, -3) + 'y';
  if (plural.endsWith('ses') || plural.endsWith('xes') || plural.endsWith('shes') || plural.endsWith('ches')) {
    return plural.slice(0, -2);
  }
  if (plural.endsWith('s')) return plural.slice(0, -1);
  return plural;
}

function lastSegment(basePath) {
  const parts = String(basePath).split('/').filter(Boolean);
  return parts.pop() || '';
}

/**
 * Find the one array field in an object. Most backends return a
 * response like `{ activities: [...], next_cursor, has_more }` for
 * a list endpoint — the array field is the data, the rest is
 * pagination metadata. If there are multiple array fields (rare),
 * fall through unchanged so the caller can disambiguate.
 */
function findArrayField(response) {
  if (!response || typeof response !== 'object') return null;
  const keys = Object.keys(response).filter(k => Array.isArray(response[k]));
  if (keys.length === 1) return keys[0];
  return null;
}

function createResource(options) {
  const opts = options || {};
  if (!opts.http) {
    throw new Error('createResource requires { http } — pass a configured HTTP instance');
  }
  if (!opts.basePath) {
    throw new Error('createResource requires basePath');
  }

  const http = opts.http;
  const base = opts.basePath;
  const decorateItem = opts.decorate || ((x) => x);
  const plural = opts.plural || lastSegment(base);
  const singular = opts.singular != null ? opts.singular : deriveSingular(plural);
  const unwrap = opts.unwrap !== false; // default true
  const cleanListParams = opts.cleanParams !== false; // default true

  function buildUrl(suffix) {
    return suffix != null && suffix !== '' ? `${base}/${suffix}` : base;
  }

  function decorateListResponse(response) {
    const arrayKey = findArrayField(response);
    if (!arrayKey) return response;
    return Object.assign({}, response, {
      [arrayKey]: response[arrayKey].map(decorateItem),
    });
  }

  function decorateOneResponse(response) {
    if (!response || typeof response !== 'object') return response;
    const keys = Object.keys(response);

    // Single-key + matches singular → unwrap and decorate the bare object.
    if (unwrap && singular && keys.length === 1 && keys[0] === singular && response[singular]) {
      return decorateItem(response[singular]);
    }

    // Otherwise, decorate the one object field we find (don't unwrap).
    const objKey = keys.find(k =>
      response[k] && typeof response[k] === 'object' && !Array.isArray(response[k])
    );
    if (objKey) {
      return Object.assign({}, response, { [objKey]: decorateItem(response[objKey]) });
    }

    return decorateItem(response);
  }

  function call(verb, suffix, data) {
    const m = String(verb).toLowerCase();
    const fn = http[m];
    if (fn) return fn.call(http, buildUrl(suffix), data);
    return http.request({ url: buildUrl(suffix), method: m, data });
  }

  return {
    basePath: base,
    plural,
    singular,

    list(params) {
      // 踩坑: WeChat's wx.request serializes null/undefined into the
      // query string inconsistently (`cursor=` for null, omitted for
      // undefined). Some backends treat `?cursor=` differently from
      // no cursor at all and either error out or page through stale
      // results. Strip falsy params before passing to http.get to
      // match the hand-rolled URL-building the consumer used to do.
      // Set `cleanParams: false` in createResource() to opt out.
      const cleaned = cleanListParams ? cleanParams(params) : params;
      return http.get(buildUrl(), cleaned).then(decorateListResponse);
    },
    get(id) {
      return http.get(buildUrl(id)).then(decorateOneResponse);
    },
    create(data) {
      return http.post(buildUrl(), data).then(decorateOneResponse);
    },
    update(id, data) {
      return http.put(buildUrl(id), data).then(decorateOneResponse);
    },
    remove(id) {
      return http.delete(buildUrl(id));
    },

    /**
     * Escape hatch for sub-resources and non-CRUD endpoints:
     *
     *   activities.custom('POST', `${id}/registrations`, data)
     *   activities.custom('POST', `${id}/preview-complete`, {...})
     *   activities.custom('GET', `${id}/matches`)
     *
     * Verbs GET/POST/PUT/DELETE go through http.get/post/put/delete;
     * anything else goes through http.request().
     */
    custom(verb, suffix, data) {
      return call(verb, suffix, data);
    },
  };
}

function cleanParams(params) {
  if (!params || typeof params !== 'object') return undefined;
  const out = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v == null || v === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

module.exports = { createResource, deriveSingular };
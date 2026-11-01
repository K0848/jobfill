/*
 * Resolve a requested URL to an existing Huashu tab without guessing from
 * titles or the active tab.  Site-specific query/path rules are explicit so
 * business identifiers (draft_id, application_id, token) are never silently
 * discarded by a generic normalizer.
 */
'use strict';

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|gclid|fbclid)$/i;

function assertUrl(value, name = 'URL') {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空字符串`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} 格式无效`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError(`${name} 只允许 HTTP(S)`);
  return parsed;
}

function normalizeUrl(value, rules = {}) {
  const parsed = assertUrl(value);
  const ignoredParams = Array.isArray(rules.ignoreQueryParams) ? rules.ignoreQueryParams : [];
  const invalid = ignoredParams.filter((key) => typeof key !== 'string' || !TRACKING_PARAM.test(key));
  if (invalid.length) throw new TypeError(`urlNormalization 只能忽略追踪参数: ${invalid.join(',')}`);
  const ignored = new Set(ignoredParams);
  for (const key of [...parsed.searchParams.keys()]) {
    if (ignored.has(key) || (rules.allowTrackingParams && TRACKING_PARAM.test(key))) parsed.searchParams.delete(key);
  }
  if (rules.ignoreTrailingSlash && parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.hash = rules.ignoreHash ? '' : parsed.hash;
  return parsed.href;
}

function tabUrl(tab) {
  return typeof tab?.url === 'string' ? tab.url : typeof tab?.pendingUrl === 'string' ? tab.pendingUrl : null;
}

function resolveTargetTab({ requestedUrl, tabs, normalize = normalizeUrl, rules = {} } = {}) {
  const requested = assertUrl(requestedUrl, 'requestedUrl');
  if (!Array.isArray(tabs)) throw new TypeError('tabs 必须是数组');
  const normalizedUrl = normalize(requested.href, rules);
  const candidates = tabs.map((tab) => {
    const url = tabUrl(tab);
    if (!url) return null;
    let normalized;
    try { normalized = normalize(url, rules); } catch { return null; }
    return { tab, url, normalized };
  }).filter(Boolean);
  const exact = candidates.filter((entry) => entry.normalized === normalizedUrl);
  if (exact.length === 1) {
    return { action: 'reuse', tabId: exact[0].tab.id ?? exact[0].tab.tabId ?? null,
      matchedUrl: exact[0].url, requestedUrl: requested.href, normalizedUrl,
      reason: 'normalized URL 唯一命中' };
  }
  if (exact.length > 1) {
    return { action: 'blocked', tabId: null, matchedUrl: null, requestedUrl: requested.href,
      normalizedUrl, reason: '同一规范化 URL 存在多个标签，禁止猜测' };
  }
  return { action: 'create', tabId: null, matchedUrl: null, requestedUrl: requested.href,
    normalizedUrl, reason: '没有规范化 URL 命中，允许新建标签' };
}

module.exports = { normalizeUrl, resolveTargetTab, assertUrl, TRACKING_PARAM };

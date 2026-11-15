/**
 * Tiny HTTP helper shared by every adapter (Node 18+ global fetch, no deps).
 *
 * Every non-2xx response is turned into an Error whose message is written for
 * a QA engineer, not a developer: "Your Jira token was rejected (401)…".
 */

const DEFAULT_TIMEOUT_MS = 30000;

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function friendly(status, service) {
  const s = service || 'the service';
  if (status === 401) return `${s} rejected the credentials (401). The token is wrong, expired or revoked.`;
  if (status === 403) return `${s} accepted the credentials but this account lacks permission (403). Ask an admin to grant access or use a token with more scopes.`;
  if (status === 404) return `${s} could not find that resource (404). Check the URL, project/space key or ID.`;
  if (status === 429) return `${s} is rate-limiting requests (429). Wait a minute and try again.`;
  if (status >= 500) return `${s} returned a server error (${status}). Try again later.`;
  return `${s} returned HTTP ${status}.`;
}

/**
 * request({ url, method, headers, body, service, timeoutMs, raw })
 *   body: object → JSON-encoded; string/Buffer → sent as-is.
 *   raw:  true → return the Response text instead of parsed JSON.
 */
async function request({ url, method = 'GET', headers = {}, body, service, timeoutMs = DEFAULT_TIMEOUT_MS, raw = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const h = { Accept: 'application/json', ...headers };
  let payload = body;
  if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
    payload = JSON.stringify(body);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new HttpError(`${service || url} did not respond within ${Math.round(timeoutMs / 1000)}s. Check the URL and your network/VPN.`, 0);
    throw new HttpError(`Could not reach ${service || url}: ${e.cause?.code || e.message}. Check the URL and your network/VPN.`, 0);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(`${friendly(res.status, service)} ${text ? '- ' + text.slice(0, 300) : ''}`.trim(), res.status, text);
  }
  if (raw) return text;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

const basicAuth = (user, secret) => 'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64');
const bearer = (token) => `Bearer ${token}`;

/** Strip HTML to readable plain text (ADO/Confluence/Jira rendered fields). */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Atlassian Document Format (Jira Cloud v3) → plain text. */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join('');
  if (['paragraph', 'heading', 'listItem', 'tableRow'].includes(node.type)) return inner + '\n';
  if (node.type === 'hardBreak') return '\n';
  return inner;
}

module.exports = { request, basicAuth, bearer, htmlToText, adfToText, HttpError };

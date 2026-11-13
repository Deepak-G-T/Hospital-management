// API client built on fetch: adds the auth token, unwraps { data }, turns errors into readable messages.
// VITE_API_URL (optional) points the site at an API on another origin; empty = same origin / Vite proxy.
export const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const TOKEN_KEY = 'medicore_token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export function rememberRole(role) {
  try { if (role) localStorage.setItem('medicore_role', role); else localStorage.removeItem('medicore_role'); } catch { /* storage unavailable */ }
}
export const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

/**
 * An error from the API. `code` is the stable machine-readable code (VALIDATION_ERROR, FORBIDDEN, REASON_REQUIRED, …): branch on it,
 * not on the message. `requestId` identifies the request in the server log (show it for server errors so support can find it).
 */
export class ApiError extends Error {
  constructor(message, status, details, code, requestId) { super(message); this.status = status; this.details = details; this.code = code; this.requestId = requestId; }
}

/** Builds an ApiError from an error response, tolerating bodies that are not the API's JSON (for example a gateway's HTML page) */
function errorFrom(res, json, fallback) {
  const err = json?.error || {};
  const message = json?.message || (res.status >= 500 ? 'The server had a problem. Please try again in a moment.' : fallback);
  return new ApiError(message, res.status, err.details ?? json?.details, err.code, json?.requestId || res.headers.get('x-request-id') || undefined);
}

/** Builds "?a=1&b=2", skipping empty values */
export function qs(params = {}) {
  const p = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, { body, params, raw, reason } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // Administrators give a reason before opening medical details; it is recorded in the audit log (URL-encoded: header-safe)
  if (reason) headers['X-Access-Reason'] = encodeURIComponent(reason);
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  let res;
  try {
    res = await fetch(`${API_ORIGIN}/api${path}${qs(params)}`, { method, headers, body: payload });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  if (res.status === 401 && token && !path.startsWith('/auth/login')) {
    setToken(null);
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?expired=1&next=${next}`;
    throw new ApiError('Your session has expired. Please log in again.', 401);
  }
  if (raw) {
    if (!res.ok) throw errorFrom(res, await res.json().catch(() => ({})), 'Download failed');
    return res;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw errorFrom(res, json, `Request failed (${res.status})`);
  return json.data !== undefined ? json.data : json;
}

export const api = {
  get: (path, params, opts) => request('GET', path, { params, ...opts }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
  /** Every item of a paginated list, for pickers and dropdowns: follows pagination.hasNextPage (pages of 100, at most `maxPages`). Other responses are returned as they are. */
  all: async (path, params = {}, maxPages = 20) => {
    const [base, query = ''] = path.split('?');
    const merged = { ...Object.fromEntries(new URLSearchParams(query)), limit: 100, ...params };
    const items = [];
    for (let page = 1; ; page += 1) {
      const r = await request('GET', base, { params: { ...merged, page } });
      if (!Array.isArray(r?.items)) return r;
      items.push(...r.items);
      if (!r.pagination?.hasNextPage || page >= maxPages) return items;
    }
  },
  /** login/register return { token, user } at the top level */
  raw: (method, path, body) => request(method, path, { body }),
};

/** Downloads a protected file (with the auth header) and saves it */
export async function download(path, params, filename, opts) {
  const res = await request('GET', path, { params, raw: true, ...opts });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const cd = res.headers.get('content-disposition');
  const match = cd && /filename="?([^"]+)"?/.exec(cd);
  a.href = url;
  a.download = filename || (match ? decodeURIComponent(match[1]) : 'download');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a protected file in a new tab (e.g. a PDF or image report) */
export async function openFile(path) {
  const res = await request('GET', path, { params: { inline: 1 }, raw: true });
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
}

// Fetch helpers with timeout and retry. All outbound traffic is plain HTTPS,
// which is the only thing the Workers runtime allows anyway.

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 25000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method,
          headers: { Accept: "application/json", ...headers },
          body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
        },
        timeoutMs
      );
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        // Do not retry client errors except 429.
        if (res.status < 500 && res.status !== 429) {
          throw new HttpError(`HTTP ${res.status}`, res.status, data);
        }
        throw new HttpError(`HTTP ${res.status}`, res.status, data);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const status = err instanceof HttpError ? err.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

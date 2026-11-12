import { timingSafeEqual } from 'node:crypto';
import { AppError, assert } from './domain.mjs';

export function equalToken(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

// The socket address is authoritative. Untrusted forwarding headers never reset a budget.
export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now(), capacity = 10000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.capacity = capacity;
    this.entries = new Map();
  }

  take(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      for (const [storedKey, stored] of this.entries) {
        if (now >= stored.resetAt) this.entries.delete(storedKey);
      }
      assert(this.entries.size < this.capacity, 'Request capacity reached. Try again shortly.', 429);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    assert(++entry.count <= this.limit, 'Too many requests. Please wait before trying again.', 429);
  }
}

export async function readJson(req) {
  const declaredSize = req.headers['content-length'];
  assert(!declaredSize || Number(declaredSize) <= 16384, 'Request is too large.', 413);
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16384) reject(new AppError('Request is too large.', 413));
      else chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
    req.on('aborted', () => reject(new AppError('Request was interrupted.', 400)));
  });
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new AppError('Invalid JSON body.'); }
  assert(result !== null && typeof result === 'object' && !Array.isArray(result),
    'The request must be a JSON object.');
  return result;
}

// Limit decoded bytes, including when the provider uses compressed HTTP responses.
export async function readResponseJson(response, maxBytes = 256 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Response body exceeded its size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

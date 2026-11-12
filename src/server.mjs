import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Simulator, PayPalSandbox } from './providers.mjs';
import { AppError, assert, SCENARIOS, CATALOG, planBundle } from './domain.mjs';
import { interpretBrief } from './ai.mjs';
import { equalToken, RateLimiter, readJson } from './security.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4317);
assert(Number.isInteger(port) && port > 0 && port < 65536, 'PORT must be a valid TCP port.');
const configuredOrigin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:' + port;
const originUrl = new URL(configuredOrigin);
assert(['http:', 'https:'].includes(originUrl.protocol) &&
  !originUrl.username && !originUrl.password &&
  configuredOrigin.replace(/\/$/, '') === originUrl.origin,
  'PUBLIC_ORIGIN must contain only the HTTP or HTTPS origin.');
const origin = originUrl.origin;
const mode = process.env.PAYMENT_MODE ?? 'simulation';
assert(['simulation', 'sandbox'].includes(mode), 'PAYMENT_MODE must be simulation or sandbox.');
const credentials = Object.fromEntries(['ticket', 'hotel', 'shuttle'].map(category => [category, {
  id: process.env['PAYPAL_' + category.toUpperCase() + '_CLIENT_ID'],
  secret: process.env['PAYPAL_' + category.toUpperCase() + '_CLIENT_SECRET'],
}]));
const sandboxConfigured = Object.values(credentials).every(value => value.id?.trim() && value.secret?.trim());
if (mode === 'sandbox') assert(sandboxConfigured, 'Configure the three Sandbox seller apps before selecting sandbox mode.');
const store = new Store(process.env.WHOLEPLAN_DB ?? join(root, 'data', 'wholeplan.sqlite'));
const provider = mode === 'simulation' ? new Simulator(store) : new PayPalSandbox({ credentials, origin });
const engine = new Engine({ store, provider });
const ai = { apiKey: process.env.GEMINI_API_KEY?.trim(), model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' };
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app', ['app.html', 'text/html; charset=utf-8']],
  ['/app/', ['app.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/landing.mjs', ['landing.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/social.svg', ['social.svg', 'image/svg+xml']],
  ['/social.png', ['social.png', 'image/png']],
  ['/assets/wholeplan-mark.png', ['assets/wholeplan-mark.png', 'image/png']],
  ['/assets/favicon-64.png', ['assets/favicon-64.png', 'image/png']],
  ['/assets/apple-touch-icon.png', ['assets/apple-touch-icon.png', 'image/png']],
  ['/assets/wholeplan-hero.webp', ['assets/wholeplan-hero.webp', 'image/webp']],
  ['/assets/wholeplan-hero-640.webp', ['assets/wholeplan-hero-640.webp', 'image/webp']],
  ['/assets/wholeplan-social.png', ['assets/wholeplan-social.png', 'image/png']],
]);
const requestBudget = new RateLimiter({ limit: 180, windowMs: 60000 });
const mutationBudget = new RateLimiter({ limit: 40, windowMs: 60000 });
const sessionBudget = new RateLimiter({ limit: 20, windowMs: 60000 });
const aiBudget = new RateLimiter({ limit: 6, windowMs: 60000 });
const aiHourlyLimit = Number(process.env.AI_REQUESTS_PER_HOUR ?? 30);
assert(Number.isInteger(aiHourlyLimit) && aiHourlyLimit >= 0, 'AI_REQUESTS_PER_HOUR must be a non-negative integer.');
const globalAiBudget = new RateLimiter({ limit: aiHourlyLimit, windowMs: 3600000, capacity: 1 });
const errorTemplate = await readFile(join(root, 'public', 'error.html'), 'utf8').catch(() => null);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sessionFor(req, res, create) {
  const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .find(value => value.startsWith('wholeplan='))?.slice(10);
  const session = /^[a-f0-9-]{36}$/.test(cookie ?? '') ? store.session(cookie) : null;
  if (session) return session;
  assert(create, 'Your session expired. Reload the workspace to start a new session.', 403);
  sessionBudget.take(req.socket.remoteAddress);
  const id = randomUUID();
  store.putSession(id, randomUUID());
  const secure = originUrl.protocol === 'https:' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'wholeplan=' + id + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400' + secure);
  return store.session(id);
}

function validatePlan(body) {
  assert(typeof body.brief === 'string' && body.brief.trim().length >= 5 && body.brief.length <= 4000,
    'Describe the plan in 5–4000 characters.');
  assert(body.useRules === undefined || typeof body.useRules === 'boolean', 'Select a valid interpretation mode.');
  const { scenario = 'success', travelers = 1 } = body;
  assert(typeof scenario === 'string' && Object.hasOwn(SCENARIOS, scenario), 'Unknown scenario.');
  assert(mode === 'simulation' || scenario === 'success', 'Choose the success scenario for PayPal Sandbox.');
  // Reject invalid financial inputs before spending a model request.
  planBundle({ budget: body.budget, maxLoss: body.maxLoss, travelers });
}

async function serveAsset(req, res, path) {
  const [file, contentType] = assets.get(path);
  let content = await readFile(join(root, 'public', file));
  if (file === 'index.html') {
    const escapedOrigin = origin.replace(/[&<>"']/g, value => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[value]);
    content = content.toString('utf8').replaceAll('{{PUBLIC_ORIGIN}}', escapedOrigin);
  }
  if (path.startsWith('/app')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (originUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, origin);
    if (['GET', 'HEAD'].includes(req.method) && assets.has(url.pathname)) {
      await serveAsset(req, res, url.pathname);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /paypal/\nSitemap: ' + origin + '/sitemap.xml\n');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + origin + '/</loc></url></urlset>');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, mode });
      return;
    }
    // An explicit route allowlist keeps probes for local files out of session storage.
    const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(prepare|commit|recover|reconcile|evidence))?$/.exec(url.pathname);
    const callback = ['/paypal/return', '/paypal/cancel'].includes(url.pathname);
    assert(match || callback || ['/api/session', '/api/plans'].includes(url.pathname), 'Not found.', 404);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    const address = req.socket.remoteAddress;
    requestBudget.take(address);
    assert(['GET', 'POST'].includes(req.method), 'Method is not allowed.', 405);
    const creatingSession = req.method === 'GET' && url.pathname === '/api/session';
    const session = sessionFor(req, res, creatingSession);
    if (req.method === 'POST') {
      assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 'Use JSON requests.', 415);
      assert(!req.headers.origin || req.headers.origin === origin, 'Origin is not allowed.', 403);
      assert(req.headers['sec-fetch-site'] !== 'cross-site', 'Cross-site requests are not allowed.', 403);
      assert(equalToken(req.headers['x-csrf-token'], session.csrf), 'Request verification failed. Reload the workspace.', 403);
      mutationBudget.take(address);
    }
    if (creatingSession) {
      json(res, 200, {
        csrf: session.csrf, mode, aiConfigured: Boolean(ai.apiKey), model: ai.model,
        sandboxConfigured, scenarios: SCENARIOS, catalog: CATALOG,
        limits: {
          suppliers: 'Sample inventory, suppliers and USD quotes for one to six travelers.',
          payments: mode === 'sandbox' ? 'PayPal Sandbox test funds. Separate seller approvals required.' : 'Local payment simulation.',
          ai: ai.apiKey ? 'Gemini interpretation is available for review.' : 'The fixed sample itinerary is active.',
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/plans') {
      const body = await readJson(req);
      validatePlan(body);
      if (ai.apiKey && body.useRules !== true) {
        aiBudget.take(address);
        globalAiBudget.take('all-model-requests');
      }
      const interpretation = await interpretBrief(body.brief, body.useRules === true ? {} : ai);
      const run = engine.create(session.id, {
        brief: body.brief, budget: body.budget, maxLoss: body.maxLoss,
        travelers: body.travelers, scenario: body.scenario, interpretation,
      });
      json(res, 201, run);
      return;
    }
    if (match) {
      const [, id, action] = match;
      if (req.method === 'GET' && !action) {
        json(res, 200, engine.view(engine.owned(id, session.id)));
        return;
      }
      if (req.method === 'GET' && action === 'evidence') {
        const run = engine.owned(id, session.id);
        res.setHeader('Content-Disposition', 'attachment; filename="wholeplan-' + id.slice(0, 8) + '.json"');
        json(res, 200, {
          exportedAt: new Date().toISOString(),
          notice: 'Sample supplier inventory. Payment mode and interpretation source are recorded.',
          ...engine.view(run),
        });
        return;
      }
      if (req.method === 'POST' && ['prepare', 'commit', 'recover', 'reconcile'].includes(action)) {
        const body = await readJson(req);
        const result = ['prepare', 'commit'].includes(action)
          ? await engine[action](id, session.id, body.manifestHash)
          : await engine[action](id, session.id);
        json(res, 200, result);
        return;
      }
    }
    if (req.method === 'GET' && callback) {
      const id = url.searchParams.get('run');
      if (url.pathname === '/paypal/return') {
        await engine.approveSeller(id, session.id, url.searchParams.get('leg'), {
          state: url.searchParams.get('state'), token: url.searchParams.get('token'),
        });
      } else {
        engine.owned(id, session.id);
      }
      res.writeHead(303, { Location: '/app?run=' + encodeURIComponent(id) });
      res.end();
      return;
    }
    throw new AppError('Not found.', 404);
  } catch (error) {
    if (error.status === 413) {
      res.setHeader('Connection', 'close');
      req.resume();
    }
    if (error.status === 429) res.setHeader('Retry-After', '60');
    if (!res.headersSent) {
      if (errorTemplate && req.method === 'GET' && req.headers.accept?.includes('text/html') &&
          !req.url.startsWith('/api/')) {
        const message = error.status ? error.message : 'The service needs another check. Open your workspace to review the saved activity.';
        const escapedMessage = message.replace(/[&<>"']/g, value => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[value]);
        const page = errorTemplate
          .replaceAll('{{STATUS}}', String(error.status ?? 500))
          .replaceAll('{{ERROR_MESSAGE}}', escapedMessage);
        res.writeHead(error.status ?? 500, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
        });
        res.end(page);
        return;
      }
      json(res, error.status ?? 500, {
        error: error.status ? error.message : 'The server could not complete the request. Your saved operation records are retained.',
        code: error.code ?? 'SERVER_ERROR',
      });
    } else res.end();
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 200;
server.listen(port, '127.0.0.1', () => {
  console.log('WholePlan: ' + origin + ' | payments=' + mode + ' | AI=' +
    (ai.apiKey ? 'Gemini configured' : 'sample itinerary') + ' | inventory=sample');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    store.close();
    process.exit(0);
  }));
}

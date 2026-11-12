import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Simulator, PayPalSandbox } from '../src/providers.mjs';
import { RateLimiter, equalToken } from '../src/security.mjs';
import { interpretBrief } from '../src/ai.mjs';

const input = {
  brief: 'A concert ticket, a room, and a shuttle.',
  budget: 30000, maxLoss: 0,
  interpretation: { source: 'rules', summary: 'Sample', categories: ['ticket', 'hotel', 'shuttle'], evidence: [] },
};

function fixture(t, overrides = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine({ store, provider: new Simulator(store) });
  const run = engine.create('private-session-cookie', { ...input, ...overrides });
  return { engine, store, run };
}

test('public plans redact session credentials, callback state and raw provider payloads', t => {
  const { engine, store, run } = fixture(t);
  const saved = store.get(run.id);
  saved.legs[0].order = {
    id: 'ORDER', status: 'CREATED',
    payer: { email_address: 'private@example.test' },
    payment_source: { paypal: { experience_context: { return_url: 'https://example.test/?state=secret-callback' } } },
    approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER',
  };
  const result = engine.view(saved);
  const serialized = JSON.stringify(result);
  assert.equal(result.owner, undefined);
  assert.equal(result.legs[0].callbackState, undefined);
  for (const value of ['private-session-cookie', 'private@example.test', 'secret-callback', saved.legs[0].callbackState]) {
    assert.ok(!serialized.includes(value));
  }
  assert.equal(result.legs[0].order.id, 'ORDER');
  assert.match(result.legs[0].order.approvalUrl, /sandbox.paypal.com/);
});

test('all frozen supplier terms and leg count are checked before creating any holds', async t => {
  for (const modify of [
    saved => { saved.legs.pop(); },
    saved => { saved.legs[0].holdSeconds = 999999; },
    saved => { saved.legs[0].term = 'Changed terms'; },
  ]) {
    const { engine, store, run } = fixture(t);
    const saved = store.get(run.id);
    modify(saved);
    store.save(saved);
    await assert.rejects(engine.prepare(run.id, 'private-session-cookie', run.manifestHash), /terms changed/);
    assert.equal(store.effects(run.id).length, 0);
  }
});

test('inherited object property names cannot select a failure scenario', t => {
  const { engine } = fixture(t);
  for (const scenario of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => engine.create('buyer', { ...input, scenario }), /Unknown scenario/);
  }
});

test('mismatched refund reconciliation preserves pending funds and flags attention', async t => {
  const { engine, run } = fixture(t, { scenario: 'pending_refund' });
  await engine.prepare(run.id, 'private-session-cookie', run.manifestHash);
  await engine.commit(run.id, 'private-session-cookie', run.manifestHash);
  let result = await engine.recover(run.id, 'private-session-cookie');
  assert.equal(result.state, 'REFUND_PENDING');
  const previous = engine.provider.readRefund.bind(engine.provider);
  engine.provider.readRefund = async (...args) => ({
    ...await previous(...args), id: 'UNRELATED-REFUND', status: 'COMPLETED',
    amount: { value: '999.00', currency_code: 'EUR' },
  });
  result = await engine.reconcile(run.id, 'private-session-cookie');
  assert.equal(result.state, 'NEEDS_ATTENTION');
  assert.equal(result.summary.refunded, 0);
  assert.equal(result.summary.refundPending, 8000);
});

test('sessions expire after 24 hours while younger sessions remain usable', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.putSession('session', 'csrf');
  const session = store.session('session');
  assert.equal(store.session('session', session.created_at + 1000).csrf, 'csrf');
  assert.equal(store.session('session', session.created_at + 86400000), undefined);
});

test('rate budgets expire, enforce capacity, and keep separate request identities', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, capacity: 2, now: () => now });
  limiter.take('address-a');
  limiter.take('address-a');
  assert.throws(() => limiter.take('address-a'), error => error.status === 429);
  limiter.take('address-b');
  assert.throws(() => limiter.take('address-c'), error => error.status === 429);
  now = 1000;
  assert.doesNotThrow(() => limiter.take('address-c'));
  assert.equal(limiter.entries.size, 1);
});

test('CSRF comparisons handle Unicode lengths and invalid input without throwing', () => {
  assert.equal(equalToken('same', 'same'), true);
  for (const value of [undefined, null, [], 'different', 'éééé']) assert.equal(equalToken(value, 'same'), false);
});

test('Sandbox checkout rejects foreign hosts, userinfo and unexpected ports', async () => {
  for (const approvalUrl of [
    'https://foreign.example/checkout',
    'http://www.sandbox.paypal.com/checkoutnow',
    'https://user:password@www.sandbox.paypal.com/checkoutnow',
    'https://www.sandbox.paypal.com:444/checkoutnow',
  ]) {
    const provider = new PayPalSandbox({
      credentials: { ticket: { id: 'test-id', secret: 'test-secret' } },
      origin: 'http://localhost:4317',
      fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/token')
        ? { access_token: 'test-token' }
        : { id: 'TEST-ORDER', status: 'CREATED', links: [{ rel: 'approve', href: approvalUrl }] }
      ), { status: 200 }),
    });
    await assert.rejects(provider.execute(
      { id: 'test-run', manifestHash: 'test-hash' },
      { category: 'ticket', name: 'Ticket', amount: 100, callbackState: 'nonce' },
      'create', { requestId: 'test-request' }
    ), /No supported PayPal Sandbox approval URL/);
  }
});

test('malformed authentication responses cannot leak response fragments through errors', async () => {
  const privateFragment = 'PRIVATE-TOKEN-FRAGMENT';
  const provider = new PayPalSandbox({
    credentials: { ticket: { id: 'test-id', secret: 'test-secret' } },
    origin: 'http://localhost:4317',
    fetchImpl: async () => new Response(privateFragment, { status: 200 }),
  });
  await assert.rejects(provider.token('ticket'), error => {
    assert.match(error.message, /authentication response was unreadable/);
    assert.ok(!error.message.includes(privateFragment));
    return true;
  });
});

test('AI extraction rejects empty evidence, duplicate categories and oversized evidence lists', async () => {
  const brief = 'A concert ticket, a room, and a shuttle.';
  const outputs = [
    { summary: 'Trip', categories: ['ticket'], evidence: [] },
    { summary: 'Trip', categories: ['ticket', 'ticket'], evidence: ['ticket'] },
    { summary: 'Trip', categories: ['ticket'], evidence: [''] },
    { summary: 'Trip', categories: ['ticket'], evidence: Array(7).fill('ticket') },
    null,
  ];
  for (const output of outputs) {
    await assert.rejects(interpretBrief(brief, {
      apiKey: 'test-only',
      fetchImpl: async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
      }), { status: 200 }),
    }), /evidence check/);
  }
});

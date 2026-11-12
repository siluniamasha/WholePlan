import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandbox } from '../src/providers.mjs';
import { interpretBrief } from '../src/ai.mjs';
const response=b=>new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}});
const modelResult=b=>response({candidates:[{content:{parts:[{text:JSON.stringify(b)}]}}]});

test('no configured model is honestly labelled rule-based',async()=>{let called=false;const r=await interpretBrief('A concert, room and shuttle',{fetchImpl:()=>{called=true;}});assert.equal(r.source,'rules');assert.equal(called,false);});
test('Gemini extraction accepts exact source evidence and discards injected financial fields',async()=>{const brief='A concert, room and shuttle';const r=await interpretBrief(brief,{apiKey:'test-only',fetchImpl:async(url,opts)=>{assert.match(url,/generativelanguage.googleapis.com/);assert.equal(opts.headers['x-goog-api-key'],'test-only');const b=JSON.parse(opts.body);assert.equal(b.generationConfig.responseMimeType,'application/json');return modelResult({summary:brief,categories:['ticket','hotel','shuttle'],evidence:['concert','room','shuttle'],budget:999999,paymentApproved:true});}});assert.equal(r.source,'gemini');assert.equal(r.budget,undefined);assert.equal(r.paymentApproved,undefined);});
test('hallucinated evidence and unavailable model cannot silently become an AI success',async()=>{await assert.rejects(interpretBrief('A concert',{apiKey:'test',fetchImpl:async()=>modelResult({summary:'Trip',categories:['ticket'],evidence:['hotel']})}),/evidence check/);await assert.rejects(interpretBrief('A concert',{apiKey:'test',fetchImpl:async()=>new Response('{}',{status:429})}),/HTTP 429/);});
test('Sandbox creates a single-seller AUTHORIZE order with stable request identifier',async()=>{const calls=[];const p=new PayPalSandbox({credentials:{ticket:{id:'test-id',secret:'test-secret'}},origin:'http://localhost:4317',fetchImpl:async(url,opts)=>{calls.push({url,...opts});return url.endsWith('/token')?response({access_token:'test-token',expires_in:300}):response({id:'ORDER-TEST',status:'CREATED',links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST'}]});}});const run={id:'run-test',manifestHash:'hash'};const leg={category:'ticket',callbackState:'nonce',name:'Ticket',amount:8000};const op={requestId:'stable-id'};const r=await p.execute(run,leg,'create',op);assert.match(r.approvalUrl,/sandbox.paypal.com/);const c=calls[1],b=JSON.parse(c.body);assert.equal(c.url,'https://api-m.sandbox.paypal.com/v2/checkout/orders');assert.equal(c.headers['PayPal-Request-Id'],'stable-id');assert.equal(b.intent,'AUTHORIZE');assert.equal(b.purchase_units.length,1);assert.equal(b.purchase_units[0].amount.value,'80.00');assert.match(b.payment_source.paypal.experience_context.return_url,/state=nonce/);await p.execute(run,leg,'create',op);assert.equal(calls.length,3);assert.equal(calls[2].headers['PayPal-Request-Id'],'stable-id');});
test('POST transport timeout is financially uncertain and never switches to live PayPal',async()=>{const urls=[];const p=new PayPalSandbox({credentials:{ticket:{id:'test',secret:'test'}},origin:'http://localhost:4317',fetchImpl:async(url)=>{urls.push(url);if(url.endsWith('/token'))return response({access_token:'token'});throw new Error('network timeout');}});await assert.rejects(p.request('ticket','/v2/payments/authorizations/AUTH/capture',{method:'POST',requestId:'stable',body:{}}),e=>e.uncertain===true);assert.ok(urls.every(u=>u.startsWith('https://api-m.sandbox.paypal.com/')));});

test('Sandbox recovery binds an unknown capture to the saved order and invoice', async () => {
  const capture = { id: 'CAPTURE', status: 'COMPLETED', invoice_id: 'run-ticket' };
  const order = {
    id: 'ORDER',
    purchase_units: [{
      reference_id: 'ticket',
      payments: { captures: [{ ...capture, id: 'OTHER', invoice_id: 'other' }, capture] },
    }],
  };
  const provider = new PayPalSandbox({
    credentials: { ticket: { id: 'test', secret: 'test' } },
    origin: 'http://localhost:4317',
    fetchImpl: async url => url.endsWith('/token') ? response({ access_token: 'test' }) : response(order),
  });
  const run = { id: 'run' };
  const leg = { category: 'ticket', order: { id: 'ORDER' } };
  assert.deepEqual(await provider.observe(run, leg, 'capture'), capture);
  assert.equal(await provider.observe({ id: 'unknown' }, leg, 'capture'), null);
  order.id = 'DIFFERENT';
  await assert.rejects(provider.observe(run, leg, 'capture'), /different order or purchase unit/);
});

test('provider response limits preserve uncertainty after a payment POST', async () => {
  const tooLarge = () => response({ text: 'x'.repeat(300 * 1024) });
  await assert.rejects(interpretBrief('A concert', {
    apiKey: 'test',
    fetchImpl: async (_, options) => {
      assert.equal(JSON.parse(options.body).generationConfig.maxOutputTokens, 4096);
      return tooLarge();
    },
  }), { code: 'AI_INVALID' });
  const provider = new PayPalSandbox({
    credentials: { ticket: { id: 'test', secret: 'test' } },
    origin: 'http://localhost:4317',
    fetchImpl: async url => url.endsWith('/token') ? response({ access_token: 'test' }) : tooLarge(),
  });
  await assert.rejects(provider.request('ticket', '/v2/payments/authorizations/AUTH/capture', {
    method: 'POST', requestId: 'stable', body: {},
  }), { uncertain: true });
});

test('buyer-approved Sandbox order returns a matching authorization', async () => {
  const authorization = { id: 'AUTH', status: 'CREATED', amount: { currency_code: 'USD', value: '80.00' } };
  const order = { id: 'ORDER', status: 'APPROVED', purchase_units: [{ reference_id: 'ticket' }] };
  const posts = [];
  const provider = new PayPalSandbox({
    credentials: { ticket: { id: 'test', secret: 'test' } },
    origin: 'http://localhost:4317',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/token')) return response({ access_token: 'test' });
      if (!url.endsWith('/authorize')) return response(order);
      posts.push(options.headers['PayPal-Request-Id']);
      return response({
        ...order, status: 'COMPLETED',
        purchase_units: [{ reference_id: 'ticket', payments: { authorizations: [authorization] } }],
      });
    },
  });
  const run = { manifestHash: 'reviewed' };
  const leg = { category: 'ticket', order: { id: 'ORDER' } };
  const op = { requestId: 'same-request' };
  assert.deepEqual(await provider.execute(run, leg, 'authorize', op), authorization);
  order.status = 'CREATED';
  await assert.rejects(provider.execute(run, leg, 'authorize', op), /buyer has not approved/);
  assert.deepEqual(posts, ['same-request']);
});

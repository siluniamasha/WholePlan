import { randomUUID } from 'node:crypto';
import { PayPalSandbox } from '../src/providers.mjs';

const id = process.env.PAYPAL_TICKET_CLIENT_ID?.trim();
const secret = process.env.PAYPAL_TICKET_CLIENT_SECRET?.trim();
if (!id || !secret) {
  console.error('Set PAYPAL_TICKET_CLIENT_ID and PAYPAL_TICKET_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const provider = new PayPalSandbox({
  credentials: { ticket: { id, secret } },
  origin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:4317',
});

try {
  await provider.token('ticket');
  console.log('PayPal Sandbox OAuth accepted the ticket app credentials.');
  const [action, orderId] = process.argv.slice(2);
  if (action === 'authorize') {
    if (!/^[A-Z0-9]+$/.test(orderId ?? '')) throw new Error('Supply the approved Sandbox order ID.');
    const authorization = await provider.execute({}, { category: 'ticket', order: { id: orderId } }, 'authorize', { requestId: randomUUID() });
    if (authorization.status !== 'CREATED' || authorization.amount?.value !== '1.00' ||
        authorization.amount?.currency_code !== 'USD') {
      throw new Error('Authorization did not match the expected USD 1.00 test hold.');
    }
    console.log(`Sandbox authorization ${authorization.id}: ${authorization.status}, USD 1.00.`);
    process.exit(0);
  }
  if (action === 'approval') {
    const order = await provider.execute(
      { id: randomUUID(), manifestHash: 'wholeplan-sandbox-smoke' },
      { category: 'ticket', callbackState: randomUUID(), name: 'Sandbox smoke test', amount: 100 },
      'create',
      { requestId: randomUUID() },
    );
    console.log(`Sandbox order ${order.id}: ${order.status}, USD 1.00.`);
    console.log(`Buyer approval: ${order.approvalUrl}`);
    process.exit(0);
  }
  if (action) throw new Error('Supported actions are approval and authorize.');
  const order = await provider.request('ticket', '/v2/checkout/orders', {
    method: 'POST',
    requestId: randomUUID(),
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: 'wholeplan-smoke',
        amount: { currency_code: 'USD', value: '1.00' },
      }],
    },
  });
  if (typeof order.id !== 'string') throw new Error('PayPal returned no order ID.');
  const orderRecord = await provider.request('ticket', `/v2/checkout/orders/${encodeURIComponent(order.id)}`);
  const amount = orderRecord.purchase_units?.[0]?.amount;
  if (orderRecord.id !== order.id || orderRecord.intent !== 'AUTHORIZE' ||
      amount?.currency_code !== 'USD' || amount?.value !== '1.00') {
    throw new Error('The retrieved order does not match the submitted test order.');
  }
  console.log(`Created and retrieved Sandbox order ${orderRecord.id} (${orderRecord.status}, USD 1.00).`);
  console.log('Buyer approval, authorization, and capture are separate tests.');
} catch (error) {
  console.error(`Sandbox smoke test failed: ${error.message}`);
  process.exitCode = 1;
}

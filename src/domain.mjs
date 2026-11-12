import { createHash } from 'node:crypto';

export const CATEGORIES = ['ticket', 'hotel', 'shuttle'];
// Fictional supplier quotes for one person. Every price and term comes from code,
// never from the model. Amounts are USD cents; these are not real travel offers.
export const CATALOG = [
  { id: 'ticket-flex', category: 'ticket', seller: 'Northstar Live', name: 'General admission', amount: 8000, cancellationFee: 0, holdSeconds: 1200, term: 'Full price refundable during this demonstration checkout window.' },
  { id: 'ticket-premium', category: 'ticket', seller: 'Northstar Live', name: 'Premium admission', amount: 12000, cancellationFee: 4000, holdSeconds: 1200, term: '$40 per person retained if cancelled after capture.' },
  { id: 'hotel-basic', category: 'hotel', seller: 'Harbor Rooms', name: 'Essential room', amount: 11000, cancellationFee: 3500, holdSeconds: 1200, term: '$35 per person retained if cancelled after capture.' },
  { id: 'hotel-flex', category: 'hotel', seller: 'Harbor Rooms', name: 'Flexible room', amount: 13500, cancellationFee: 0, holdSeconds: 1200, term: 'Full price refundable during this demonstration checkout window.' },
  { id: 'shuttle-shared', category: 'shuttle', seller: 'Loop Transit', name: 'Shared return shuttle', amount: 3000, cancellationFee: 0, holdSeconds: 1200, term: 'Full price refundable during this demonstration checkout window.' },
  { id: 'shuttle-express', category: 'shuttle', seller: 'Loop Transit', name: 'Express return shuttle', amount: 4000, cancellationFee: 500, holdSeconds: 1200, term: '$5 per person retained if cancelled after capture.' }
];
export const SCENARIOS = {
  success: { name: 'Everything succeeds', description: 'All three suppliers and payments complete.' },
  confirmation_failure: { name: 'Shuttle booking fails after the payments', description: 'All three payments complete, but the shuttle cannot finalize its fictional booking. Recovery follows the accepted supplier cancellation terms; compare the $0 and $35 cancellation allowances.' },
  supplier_failure: { name: 'Hotel fails after the ticket is charged', description: 'The ticket capture completes. The hotel fails before its capture. Recovery refunds the ticket and voids the other holds.' },
  lost_response: { name: 'A capture response is lost', description: 'The provider commits the ticket payment, but its response is lost. Reconciliation must discover it without another charge.' },
  pending_refund: { name: 'The refund takes time', description: 'Hotel failure triggers recovery. The ticket refund remains pending until a later reconciliation.' },
  failed_refund: { name: 'Recovery needs attention', description: 'Hotel failure triggers recovery, but the provider rejects the ticket refund. The interface must preserve the unresolved amount.' },
  expired_hold: { name: 'A supplier reservation expires', description: 'The reservation deadline is advanced before capture. No capture may be sent.' }
};
export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
export function assert(condition, message, status = 400, code) { if (!condition) throw new AppError(message, status, code); }
export function cents(value, name = 'Amount') {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= 100000000, `${name} must be a non-negative integer number of cents.`);
  return value;
}
export function manifestHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function planBundle({ budget, maxLoss, travelers = 1, categories = CATEGORIES }) {
  cents(budget, 'Budget'); cents(maxLoss, 'Cancellation allowance');
  assert(budget > 0, 'Set a positive budget.');
  assert(Number.isInteger(travelers) && travelers >= 1 && travelers <= 6, 'Choose one to six travelers.');
  assert(Array.isArray(categories) && categories.length === 3 && CATEGORIES.every(x => categories.includes(x)), 'This prototype supports a concert ticket, room, and shuttle together.');
  let combinations = [[]];
  for (const category of CATEGORIES) combinations = combinations.flatMap(xs => CATALOG.filter(q => q.category === category).map(q => [...xs, { ...q, amount: q.amount * travelers, cancellationFee: q.cancellationFee * travelers, travelers }]));
  const candidates = combinations.map(legs => ({ legs, total: legs.reduce((s,x) => s+x.amount,0), declaredLoss: legs.reduce((s,x) => s+x.cancellationFee,0) })).sort((a,b) => a.total-b.total || a.declaredLoss-b.declaredLoss);
  const cheapest = candidates[0];
  const eligible = candidates.filter(x => x.total <= budget && x.declaredLoss <= maxLoss);
  const chosen = eligible[0] ?? null;
  const minimumReversible = candidates.filter(x=>x.declaredLoss<=maxLoss).sort((a,b)=>a.total-b.total)[0];
  return {
    constraints: { budget, maxLoss, travelers, categories: [...CATEGORIES] },
    chosen, cheapest, compared: candidates.length,
    eligibleCount: eligible.length,
    extraForRecovery: chosen ? chosen.total-cheapest.total : null,
    requiredBudget: minimumReversible?.total ?? null,
    reason: chosen ? (chosen.total > cheapest.total ? `The cheapest bundle exceeds your cancellation allowance. This bundle costs $${((chosen.total-cheapest.total)/100).toFixed(2)} more and meets the declared terms.` : 'The lowest priced bundle meets your declared budget and cancellation allowance.') : 'No bundle meets both limits. Change the budget or cancellation allowance explicitly; nothing has been reserved.',
    limitations: 'Supplier terms are simulated. Cancellation fees exclude processing fees, FX, and supplier non-performance. This is a terms-based comparison, not a loss guarantee or insurance.'
  };
}
export function createManifest(plan) {
  assert(plan.chosen, 'No eligible bundle.');
  return { version: 1, currency: 'USD', constraints: plan.constraints, legs: plan.chosen.legs.map(({id,category,seller,name,amount,cancellationFee,holdSeconds,term,travelers})=>({id,category,seller,name,amount,cancellationFee,holdSeconds,term,travelers})) };
}
export function captureRejected(capture) {
  return ['DECLINED', 'FAILED'].includes(capture?.status);
}

export function financialSummary(run) {
  let held=0, charged=0, refunded=0, refundPending=0, capturePending=0;
  for(const leg of run.legs){
    if(leg.authorization && (!leg.capture || captureRejected(leg.capture)) && !leg.voided) held+=leg.amount;
    if(leg.capture?.status==='PENDING') capturePending+=leg.amount;
    if(['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(leg.capture?.status)) charged+=leg.amount;
    if(leg.refund?.status==='COMPLETED') refunded+=leg.refundAmount;
    if(leg.refund?.status==='PENDING') refundPending+=leg.refundAmount;
  }
  return { held, charged, refunded, refundPending, capturePending, netCharged: charged-refunded, declaredFees: run.legs.filter(x=>['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(x.capture?.status)).reduce((s,x)=>s+x.cancellationFee,0) };
}

import { AppError, assert } from './domain.mjs';
import { readResponseJson } from './security.mjs';

export class ProviderError extends AppError {
  constructor(message,{uncertain=false,status=502,code='PROVIDER_ERROR'}={}){super(message,status,code);this.uncertain=uncertain;}
}
export class Simulator {
  constructor(store){this.store=store;this.mode='simulation';}
  async execute(run,leg,action,op){
    const existing=this.store.effect(op.id);
    if(existing)return existing.result;
    if(action==='capture'&&leg.category==='hotel'&&['supplier_failure','pending_refund','failed_refund'].includes(run.scenario))throw new ProviderError('The simulated hotel could not complete its booking.',{uncertain:false,code:'SUPPLIER_UNAVAILABLE'});
    if(action==='refund'&&run.scenario==='failed_refund')throw new ProviderError('The simulated provider declined the refund. Manual attention is required.',{uncertain:false,code:'REFUND_FAILED'});
    const amount=action==='refund'?leg.amount-leg.cancellationFee:leg.amount;
    const result={id:`SIM-${action.toUpperCase()}-${op.requestId.slice(0,12)}`,status:action==='create'?'CREATED':action==='authorize'?'CREATED':action==='void'?'VOIDED':action==='refund'&&run.scenario==='pending_refund'?'PENDING':'COMPLETED',amount:{currency_code:'USD',value:(amount/100).toFixed(2)},approvalUrl:null};
    this.store.putEffect(op.id,run.id,{action,category:leg.category,result});
    if(action==='capture'&&leg.category==='ticket'&&run.scenario==='lost_response')throw new ProviderError('Simulated response loss after the provider committed the payment.',{uncertain:true,code:'OUTCOME_UNKNOWN'});
    return result;
  }
  async observe(run,leg,action){return this.store.effect(`${run.id}:${leg.category}:${action}`)?.result??null;}
  async readRefund(run,leg,{settlePending=false}={}){
    const id=`${run.id}:${leg.category}:refund`,effect=this.store.effect(id);
    if(!effect)return null;
    if(settlePending&&effect.result.status==='PENDING'){effect.result.status='COMPLETED';this.store.putEffect(id,run.id,effect);}
    return effect.result;
  }
}
const BASE='https://api-m.sandbox.paypal.com';
export class PayPalSandbox {
  constructor({credentials,origin,fetchImpl=fetch}){this.credentials=credentials;this.origin=origin;this.fetch=fetchImpl;this.tokens=new Map();this.mode='sandbox';}
  async token(category){
    const cached=this.tokens.get(category);if(cached&&cached.until>Date.now())return cached.value;
    const c=this.credentials[category];assert(c?.id&&c?.secret,`Sandbox credentials are missing for ${category}.`,503);
    let r;try{r=await this.fetch(`${BASE}/v1/oauth2/token`,{method:'POST',redirect:'error',headers:{Authorization:`Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(15000)});}catch{throw new ProviderError('Could not obtain a Sandbox access token. No payment request was sent.');}
    if(!r.ok){
      await r.body?.cancel().catch(() => {});
      throw new ProviderError(`Sandbox authentication failed (HTTP ${r.status}).`);
    }
    let b;
    try { b = await readResponseJson(r); }
    catch { throw new ProviderError('Sandbox authentication response was unreadable.'); }
    assert(typeof b?.access_token==='string'&&b.access_token.length>0,'Sandbox returned no access token.',502);
    this.tokens.set(category,{value:b.access_token,until:Date.now()+Math.max(0,(b.expires_in??300)-60)*1000});return b.access_token;
  }
  async request(category,path,{method='GET',body,requestId}={}){
    const token=await this.token(category);let r;
    try{r=await this.fetch(`${BASE}${path}`,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'return=representation',...(requestId?{'PayPal-Request-Id':requestId}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}catch{throw new ProviderError('Sandbox response was not received. The financial outcome must be reconciled.',{uncertain:method!=='GET',code:'OUTCOME_UNKNOWN'});}
    if(!r.ok){
      let issue = '';
      try {
        const error = await readResponseJson(r);
        const code = error?.details?.[0]?.issue ?? error?.name;
        if (typeof code === 'string') issue = code.replace(/[^A-Z0-9_]/g, '').slice(0, 90);
      } catch {}
      const conflict = issue.includes('ALREADY_') || issue === 'PENDING_CAPTURE';
      throw new ProviderError(`Sandbox returned HTTP ${r.status}${issue?` (${issue})`:''}.`,{
        uncertain:method!=='GET'&&(conflict||r.status>=500||[408,409,429].includes(r.status)),
        code:'PAYPAL_ERROR',
      });
    }
    if(r.status===204)return {status:'VOIDED'};
    try{return await readResponseJson(r);}catch{throw new ProviderError('Sandbox returned an unreadable response.',{uncertain:method!=='GET'});}
  }
  orderPayments(order, leg, expectedReference = leg.category) {
    const units = order?.purchase_units;
    assert(order?.id === leg.order.id && Array.isArray(units) &&
      units.length === 1 && units[0] &&
      (expectedReference === null || units[0].reference_id === expectedReference),
      'Sandbox returned a different order or purchase unit.', 502);
    return units[0].payments;
  }
  async execute(run,leg,action,op){
    const opts={method:'POST',requestId:op.requestId};
    if(action==='create'){
      const query=new URLSearchParams({run:run.id,leg:leg.category,state:leg.callbackState});
      const result=await this.request(leg.category,'/v2/checkout/orders',{...opts,body:{intent:'AUTHORIZE',purchase_units:[{reference_id:leg.category,custom_id:run.manifestHash,description:`WholePlan demonstration: ${leg.name}`,amount:{currency_code:'USD',value:(leg.amount/100).toFixed(2)}}],payment_source:{paypal:{experience_context:{return_url:`${this.origin}/paypal/return?${query}`,cancel_url:`${this.origin}/paypal/cancel?${query}`,user_action:'CONTINUE',shipping_preference:'NO_SHIPPING'}}}}});
      const approval=Array.isArray(result?.links) ? result.links.find(x=>x?.rel==='payer-action'||x?.rel==='approve')?.href : null;
      const approvalUrl = typeof approval === 'string' ? URL.parse(approval) : null;
      if (approvalUrl?.origin !== 'https://www.sandbox.paypal.com' || approvalUrl.username || approvalUrl.password) {
        throw new ProviderError('No supported PayPal Sandbox approval URL was returned.', { uncertain: true });
      }
      return {...result,approvalUrl:approval};
    }
    if(action==='authorize'){
      const order=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}`);
      // The standalone smoke command can authorize a buyer-approved test order by ID.
      const reference=run.manifestHash?leg.category:null;
      const existing=this.orderPayments(order,leg,reference)?.authorizations;
      if(existing?.length===1)return existing[0];
      assert(!existing?.length,'Sandbox returned multiple authorizations for this order.',502);
      assert(order.status==='APPROVED','The buyer has not approved this Sandbox order.',409);
      const result=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}/authorize`,{...opts,body:{}});
      let auth;
      try {
        const authorizations=this.orderPayments(result,leg,reference)?.authorizations;
        if(authorizations?.length===1)auth=authorizations[0];
      } catch {}
      if(!auth)throw new ProviderError('Sandbox returned no matching authorization reference. Reconcile before retrying.',{uncertain:true});
      return auth;
    }
    if(action==='capture')return this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}/capture`,{...opts,body:{amount:{currency_code:'USD',value:(leg.amount/100).toFixed(2)},final_capture:true,invoice_id:`${run.id}-${leg.category}`}});
    if(action==='void')return this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}/void`,opts);
    if(action==='refund')return this.request(leg.category,`/v2/payments/captures/${encodeURIComponent(leg.capture.id)}/refund`,{...opts,body:{amount:{currency_code:'USD',value:((leg.amount-leg.cancellationFee)/100).toFixed(2)}}});
    throw new AppError('Unsupported provider action.');
  }
  async observe(run,leg,action){
    if(action==='void'){
      if(!leg.authorization?.id)return null;
      const auth=await this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}`);
      return auth?.id===leg.authorization.id&&auth.status==='VOIDED'?{id:auth.id,status:'VOIDED'}:null;
    }
    if(action==='capture'&&leg.capture?.id){
      return this.request(leg.category,`/v2/payments/captures/${encodeURIComponent(leg.capture.id)}`);
    }
    if(!leg.order?.id||!['authorize','capture'].includes(action))return null;
    const order=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}`);
    const payments=this.orderPayments(order,leg);
    if(action==='authorize'){
      const authorizations=payments?.authorizations;
      return authorizations?.length===1?authorizations[0]:null;
    }
    const captures=payments?.captures?.filter(capture=>capture.invoice_id===`${run.id}-${leg.category}`);
    if(captures?.length===1)return captures[0];
    return null;
  }
  async readRefund(run,leg){return this.request(leg.category,`/v2/payments/refunds/${encodeURIComponent(leg.refund.id)}`);}
}

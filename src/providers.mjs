import { AppError, assert } from './domain.mjs';

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
    let r;try{r=await this.fetch(`${BASE}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(15000)});}catch{throw new ProviderError('Could not obtain a Sandbox access token. No payment request was sent.');}
    if(!r.ok)throw new ProviderError(`Sandbox authentication failed (HTTP ${r.status}).`);
    const b=await r.json();assert(typeof b.access_token==='string','Sandbox returned no access token.',502);
    this.tokens.set(category,{value:b.access_token,until:Date.now()+Math.max(0,(b.expires_in??300)-60)*1000});return b.access_token;
  }
  async request(category,path,{method='GET',body,requestId}={}){
    const token=await this.token(category);let r;
    try{r=await this.fetch(`${BASE}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'return=representation',...(requestId?{'PayPal-Request-Id':requestId}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}catch{throw new ProviderError('Sandbox response was not received. The financial outcome must be reconciled.',{uncertain:method!=='GET',code:'OUTCOME_UNKNOWN'});}
    if(!r.ok){let issue='';try{const b=await r.json();issue=b.details?.[0]?.issue??b.name??'';}catch{}
      throw new ProviderError(`Sandbox returned HTTP ${r.status}${issue?` (${String(issue).replace(/[^A-Z0-9_]/g,'').slice(0,90)})`:''}.`,{uncertain:method!=='GET'&&(r.status>=500||r.status===408||r.status===429),code:'PAYPAL_ERROR'});
    }
    if(r.status===204)return {status:'VOIDED'};
    try{return await r.json();}catch{throw new ProviderError('Sandbox returned an unreadable response.',{uncertain:method!=='GET'});}
  }
  async execute(run,leg,action,op){
    const opts={method:'POST',requestId:op.requestId};
    if(action==='create'){
      const query=new URLSearchParams({run:run.id,leg:leg.category,state:leg.callbackState});
      const result=await this.request(leg.category,'/v2/checkout/orders',{...opts,body:{intent:'AUTHORIZE',purchase_units:[{reference_id:leg.category,custom_id:run.manifestHash,description:`WholePlan demonstration: ${leg.name}`,amount:{currency_code:'USD',value:(leg.amount/100).toFixed(2)}}],payment_source:{paypal:{experience_context:{return_url:`${this.origin}/paypal/return?${query}`,cancel_url:`${this.origin}/paypal/cancel?${query}`,user_action:'CONTINUE',shipping_preference:'NO_SHIPPING'}}}}});
      const approval=result.links?.find(x=>x.rel==='payer-action'||x.rel==='approve')?.href;
      assert(approval&&new URL(approval).protocol==='https:'&&new URL(approval).hostname==='www.sandbox.paypal.com','No supported PayPal Sandbox approval URL was returned.',502);
      return {...result,approvalUrl:approval};
    }
    if(action==='authorize'){
      const order=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}`);
      const found=order.purchase_units?.[0]?.payments?.authorizations?.[0];if(found)return found;
      assert(order.id===leg.order.id&&order.status==='APPROVED','The buyer has not approved this Sandbox order.',409);
      const result=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}/authorize`,{...opts,body:{}});
      const auth=result.purchase_units?.[0]?.payments?.authorizations?.[0];if(!auth)throw new ProviderError('Sandbox returned no authorization reference. Reconcile before retrying.',{uncertain:true});return auth;
    }
    if(action==='capture')return this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}/capture`,{...opts,body:{amount:{currency_code:'USD',value:(leg.amount/100).toFixed(2)},final_capture:true,invoice_id:`${run.id}-${leg.category}`}});
    if(action==='void')return this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}/void`,opts);
    if(action==='refund')return this.request(leg.category,`/v2/payments/captures/${encodeURIComponent(leg.capture.id)}/refund`,{...opts,body:{amount:{currency_code:'USD',value:((leg.amount-leg.cancellationFee)/100).toFixed(2)}}});
    throw new AppError('Unsupported provider action.');
  }
  async observe(run,leg,action){
    if(!leg.order?.id)return null;
    const order=await this.request(leg.category,`/v2/checkout/orders/${encodeURIComponent(leg.order.id)}`);
    const payments=order.purchase_units?.[0]?.payments;
    if(action==='authorize')return payments?.authorizations?.[0]??null;
    if(action==='capture')return payments?.captures?.find(x=>['COMPLETED','PENDING','REFUNDED','PARTIALLY_REFUNDED'].includes(x.status))??null;
    if(action==='void'){
      const auth=await this.request(leg.category,`/v2/payments/authorizations/${encodeURIComponent(leg.authorization.id)}`);
      return auth.status==='VOIDED'?{id:auth.id,status:'VOIDED'}:null;
    }
    // Refund replay uses the persisted idempotency key. No new refund is inferred
    // solely from an aggregate refunded amount because it may belong to another action.
    return null;
  }
  async readRefund(run,leg){return this.request(leg.category,`/v2/payments/refunds/${encodeURIComponent(leg.refund.id)}`);}
}

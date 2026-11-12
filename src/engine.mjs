import { randomUUID } from 'node:crypto';
import { assert, AppError, planBundle, createManifest, manifestHash, financialSummary, captureRejected, SCENARIOS } from './domain.mjs';
import { ProviderError } from './providers.mjs';

function operationMessage(error) {
  return error instanceof AppError ? error.message : 'The operation was interrupted. Check the saved provider records.';
}

function paymentReference(result) {
  if (!result) return null;
  return {
    id: result.id, status: result.status,
    amount: result.amount ? { currency_code: result.amount.currency_code, value: result.amount.value } : undefined,
    approvalUrl: result.approvalUrl,
  };
}

function applyConfirmedOperation(leg, action, result) {
  if (action === 'create') leg.order ??= result;
  if (action === 'authorize') leg.authorization ??= result;
  if (action === 'capture') leg.capture ??= result;
  if (action === 'refund') {
    leg.refund ??= result;
    leg.refundAmount = leg.amount - leg.cancellationFee;
  }
  if (action === 'void') leg.voided = true;
}

function hasConfirmedResult(op) {
  // Older rows could be marked FAILED by an audit log error after the result was saved.
  return op?.status === 'SUCCEEDED' || (op?.status === 'FAILED' && Boolean(op.result));
}

export class Engine {
  constructor({store,provider,now=()=>Date.now()}){this.store=store;this.provider=provider;this.now=now;this.locks=new Map();}
  async locked(id,fn){const previous=this.locks.get(id)??Promise.resolve();let release;const gate=new Promise(r=>release=r);const tail=previous.catch(()=>{}).then(()=>gate);this.locks.set(id,tail);await previous.catch(()=>{});try{return await fn();}finally{release();if(this.locks.get(id)===tail)this.locks.delete(id);}}
  owned(id,owner){const r=this.store.get(id);assert(r&&r.owner===owner,'Bundle not found.',404);assert(r.mode===this.provider.mode,'This bundle belongs to a different payment mode. Start a new one.',409);return r;}
  view(run) {
    const { owner, ...publicRun } = run;
    const operations = this.store.operations(run.id);
    const legs = run.legs.map(leg => ({ ...leg }));
    for (const op of operations) {
      const leg = legs.find(leg => leg.category === op.category);
      if (leg && hasConfirmedResult(op)) applyConfirmedOperation(leg, op.action, op.result);
    }
    return {
      ...publicRun,
      legs: legs.map(({ callbackState, ...leg }) => ({
        ...leg,
        order: paymentReference(leg.order),
        authorization: paymentReference(leg.authorization),
        capture: paymentReference(leg.capture),
        refund: paymentReference(leg.refund),
      })),
      summary: financialSummary({ legs }),
      events: this.store.events(run.id),
      operations: operations.map(({ id, action, category, status, requestId, error }) =>
        ({ id, action, category, status, requestId, error })),
    };
  }
  create(owner,{brief,budget,maxLoss,travelers=1,scenario='success',interpretation}){
    assert(typeof brief==='string'&&brief.trim().length>=5&&brief.length<=4000,'Describe the trip in 5–4000 characters.');
    assert(typeof scenario === 'string' && Object.hasOwn(SCENARIOS, scenario),'Unknown scenario.');
    assert(this.provider.mode==='simulation'||scenario==='success','Injected failures are available only in the labelled simulator.');
    const plan=planBundle({budget,maxLoss,travelers,categories:interpretation.categories});
    const manifest=plan.chosen?createManifest(plan):null;
    const run={id:randomUUID(),owner,brief:brief.trim(),createdAt:new Date(this.now()).toISOString(),mode:this.provider.mode,scenario,interpretation,plan,manifest,manifestHash:manifest?manifestHash(manifest):null,state:manifest?'DRAFT':'BLOCKED',legs:manifest?manifest.legs.map(x=>({...x,callbackState:randomUUID(),reservation:null,order:null,authorization:null,capture:null,refund:null,voided:false,refundAmount:0})):[],recoveryReason:null,approvedAt:null};
    this.store.save(run);this.store.event(run.id,'PLANNED',plan.reason,{mode:run.mode,compared:plan.compared,aiSource:interpretation.source});return this.view(run);
  }
  save(run){this.store.save(run);}
  checkManifest(run) {
    assert(run.manifest && run.manifestHash === manifestHash(run.manifest),
      'Approved bundle changed. Start a new review.', 409);
    assert(run.legs.length === run.manifest.legs.length && run.legs.every((leg, index) => {
      const approved = run.manifest.legs[index];
      const currentTerms = Object.fromEntries(Object.keys(approved).map(key => [key, leg[key]]));
      return manifestHash(currentTerms) === manifestHash(approved);
    }), 'Bundle terms changed after approval.', 409);
  }
  validateResult(leg,action,result){
    assert(result&&typeof result.status==='string','Provider returned no status.',502);
    if(action==='create')assert(typeof result.id==='string'&&result.id.length>0,'Provider returned no order reference.',502);
    if(['authorize','capture','refund'].includes(action)){
      const expected=action==='refund'?leg.amount-leg.cancellationFee:leg.amount;
      assert(result.amount?.currency_code==='USD'&&result.amount?.value===(expected/100).toFixed(2),'Provider amount or currency disagrees with the approved bundle.',502);
      assert(typeof result.id==='string'&&result.id.length>0,'Provider returned no operation reference.',502);
    }
    if(action==='void')assert(result.status==='VOIDED','Void has not been confirmed.',502);
    if(action==='authorize')assert(result.status==='CREATED','Authorization is not confirmed as ready for capture.',502);
    if (action === 'capture') {
      assert(['COMPLETED', 'PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DECLINED', 'FAILED'].includes(result.status),
        'Provider returned an unsupported capture status.', 502);
      assert(!leg.capture || result.id === leg.capture.id, 'Capture reference changed during reconciliation.', 502);
    }
  }
  async operation(run,leg,action,{retryUncertain=false}={}){
    this.checkManifest(run);
    const id=`${run.id}:${leg.category}:${action}`;
    let op=this.store.op(id);
    if(hasConfirmedResult(op)){
      this.validateResult(leg,action,op.result);
      return op.result;
    }
    if(op?.status==='FAILED')throw new ProviderError(op.error??'A previous provider action failed.');
    if(op?.status==='UNKNOWN'||op?.status==='STARTED'){
      const observed=await this.provider.observe(run,leg,action);
      if(observed){
        this.validateResult(leg,action,observed);
        const result=paymentReference(observed);
        this.store.putOp({...op,status:'SUCCEEDED',error:undefined,result});
        this.store.event(run.id,'RECONCILED',`Recovered ${leg.category} ${action} from provider records.`,{providerId:result.id});
        return result;
      }
      if(!retryUncertain)throw new ProviderError('The earlier operation outcome is still unknown. Reconcile before proceeding.',{uncertain:true,code:'OUTCOME_UNKNOWN'});
      assert(this.now()-op.startedAt<30*60*1000,'Uncertain operation is outside this demo’s retry window. Review it manually.',409);
      this.store.event(run.id,'RETRY_SAME_OPERATION',`Retrying ${leg.category} ${action} with the original request identifier.`);
    }
    op??={id,runId:run.id,category:leg.category,action,requestId:randomUUID(),startedAt:this.now()};
    op.status='STARTED';this.store.putOp(op);
    this.store.event(run.id,'PROVIDER_REQUEST',`${leg.seller}: ${action} requested.`,{requestId:op.requestId,mode:run.mode});
    let result;
    try{
      result=await this.provider.execute(run,leg,action,op);
      // An invalid success response leaves the financial outcome uncertain.
      try{this.validateResult(leg,action,result);}catch(e){throw new ProviderError(e.message,{uncertain:true,code:'PROVIDER_MISMATCH'});}
      result=paymentReference(result);
    }catch(error){
      const uncertain = !(error instanceof AppError) || error.uncertain;
      const message = operationMessage(error);
      this.store.putOp({...op,status:uncertain?'UNKNOWN':'FAILED',error:message});
      this.store.event(run.id,uncertain?'OUTCOME_UNKNOWN':'PROVIDER_REJECTED',`${leg.seller}: ${message}`);
      throw error;
    }
    // If this write fails, STARTED remains available for provider reconciliation.
    this.store.putOp({...op,status:'SUCCEEDED',error:undefined,result});
    this.store.event(run.id,'PROVIDER_CONFIRMED',`${leg.seller}: ${action} returned ${result.status}.`,{providerId:result.id??null});
    return result;
  }
  async prepare(id,owner,hash){return this.locked(id,async()=>{
    const run=this.owned(id,owner);assert(hash===run.manifestHash,'Review the current bundle before approving.',409);
    if(['READY','AWAITING_APPROVAL'].includes(run.state))return this.view(run);
    assert(['DRAFT','PREPARING'].includes(run.state),'This bundle cannot be prepared in its current state.',409);
    this.checkManifest(run);run.state='PREPARING';run.approvedAt??=this.now();this.save(run);
    try{
      for(const leg of run.legs){
        if(!leg.reservation){leg.reservation={id:`RES-${randomUUID().slice(0,8)}`,expiresAt:this.now()+leg.holdSeconds*1000,status:'HELD',source:'simulated supplier'};this.save(run);this.store.event(id,'INVENTORY_HELD',`${leg.seller}: fictional inventory held for ${leg.holdSeconds/60} minutes.`);}
      }
      for(const leg of run.legs){
        this.checkReservations(run);
        if(!leg.order){leg.order=await this.operation(run,leg,'create',{retryUncertain:true});this.save(run);}
        if(run.mode==='simulation'&&!leg.authorization){leg.authorization=await this.operation(run,leg,'authorize',{retryUncertain:true});this.save(run);}
      }
      run.state=run.legs.every(x=>x.authorization)?'READY':'AWAITING_APPROVAL';this.save(run);
      this.store.event(id,'APPROVAL',run.mode==='simulation'?'Simulated buyer approvals recorded. No PayPal account was contacted.':'Review and approve each seller’s separate PayPal Sandbox order. Nothing has been captured.');
    }catch(error){run.state=error.uncertain?'PREPARING':'RECOVERY_REQUIRED';run.recoveryReason=operationMessage(error);this.save(run);}
    return this.view(run);
  });}
  checkReservations(run){assert(run.legs.every(x=>x.reservation?.status==='HELD'&&x.reservation.expiresAt>this.now()+3000),'A supplier reservation expired or has insufficient time remaining. Recover the holds and start a new plan.',409,'RESERVATION_EXPIRED');}
  async approveSeller(id,owner,category,{state,token}){return this.locked(id,async()=>{
    const run=this.owned(id,owner);const leg=run.legs.find(x=>x.category===category);
    assert(leg&&state===leg.callbackState&&token===leg.order?.id,'Invalid payment return.',403);
    assert(['AWAITING_APPROVAL','READY'].includes(run.state),'This approval session is no longer active.',409);
    this.checkReservations(run);
    if(!leg.authorization){leg.authorization=await this.operation(run,leg,'authorize',{retryUncertain:true});this.save(run);}
    assert(leg.authorization.status==='CREATED','Authorization is not ready for capture.',409);
    run.state=run.legs.every(x=>x.authorization)?'READY':'AWAITING_APPROVAL';this.save(run);return this.view(run);
  });}
  async commit(id,owner,hash){return this.locked(id,async()=>{
    const run=this.owned(id,owner);assert(hash===run.manifestHash,'Approved bundle does not match.',409);
    if(run.state==='COMPLETED')return this.view(run);
    assert(['READY','RUNNING','OUTCOME_UNKNOWN'].includes(run.state),'Finish approvals or recovery before executing this bundle.',409);
    this.checkManifest(run);
    try{
      if(run.scenario==='expired_hold'&&run.state==='READY'){run.legs[1].reservation.expiresAt=this.now()-1;this.save(run);}
      this.checkReservations(run);
      assert(run.legs.every(x=>x.authorization?.status==='CREATED'),'All seller authorizations are required before any capture.',409);
      run.state='RUNNING';this.save(run);
      // The entire frozen bundle has passed the declared loss cap. Within it,
      // defer higher cancellation penalties; tie order is explicit and repeatable.
      const order=[...run.legs].sort((a,b)=>a.cancellationFee-b.cancellationFee||['ticket','hotel','shuttle'].indexOf(a.category)-['ticket','hotel','shuttle'].indexOf(b.category));
      for(const leg of order){
        if(leg.capture?.status==='COMPLETED')continue;
        this.checkReservations(run);
        leg.capture=await this.operation(run,leg,'capture');this.save(run);
        if(captureRejected(leg.capture))throw new ProviderError(`${leg.seller} capture was ${leg.capture.status.toLowerCase()}.`);
        if(leg.capture.status!=='COMPLETED'){run.state='OUTCOME_UNKNOWN';run.recoveryReason=`${leg.seller} capture is ${leg.capture.status}.`;this.save(run);return this.view(run);}
      }
      this.checkReservations(run);
      // These are cooperating, simulated supplier confirmation transitions.
      if(run.mode==='simulation'&&run.scenario==='confirmation_failure')throw new ProviderError('The simulated shuttle could not finalize its booking after the payments completed. Other bookings must be cancelled under their accepted terms.',{code:'SUPPLIER_CONFIRMATION_FAILED'});
      for(const leg of run.legs)leg.reservation.status='CONFIRMED';
      run.state='COMPLETED';run.recoveryReason=null;this.save(run);
    }catch(error){run.state=error.uncertain?'OUTCOME_UNKNOWN':'RECOVERY_REQUIRED';run.recoveryReason=operationMessage(error);this.save(run);}
    if(run.state==='COMPLETED')this.store.event(id,'BUNDLE_COMPLETED','All simulated supplier bookings and all payment captures are confirmed.');
    return this.view(run);
  });}
  async recoverInternal(run,{settlePending=false}={}){
    this.checkManifest(run);run.state='RECOVERING';this.save(run);let unresolved=false,pending=false;
    for(const leg of [...run.legs].reverse()){
      try{
        // A crash after provider success can occur before the leg was updated.
        for(const action of ['authorize','capture','refund','void']){
          const op=this.store.op(`${run.id}:${leg.category}:${action}`);
          if(hasConfirmedResult(op)){
            if(op.status==='FAILED'){
              this.validateResult(leg,action,op.result);
              this.store.putOp({...op,status:'SUCCEEDED',error:undefined,result:paymentReference(op.result)});
            }
            applyConfirmedOperation(leg,action,op.result);
          }else if(op&&['UNKNOWN','STARTED'].includes(op.status)){
            const observed=paymentReference(await this.provider.observe(run,leg,action));
            if(!observed){unresolved=true;throw new ProviderError(`Cannot recover ${leg.seller} while its ${action} outcome is unknown.`,{uncertain:true});}
            this.validateResult(leg,action,observed);this.store.putOp({...op,status:'SUCCEEDED',error:undefined,result:observed});
            applyConfirmedOperation(leg,action,observed);
          }
        }
        if(leg.capture&&!captureRejected(leg.capture)){
          if(!['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(leg.capture.status))throw new ProviderError('Capture is still pending. Reconcile it before requesting a refund.',{uncertain:true});
          if(leg.capture.status!=='COMPLETED'&&!leg.refund){
            throw new ProviderError('PayPal reports a prior refund. Verify its amount before requesting another.',{uncertain:true});
          }
          leg.refundAmount=leg.amount-leg.cancellationFee;
          if(leg.refundAmount>0&&!leg.refund)leg.refund=await this.operation(run,leg,'refund');
          if (leg.refund?.status === 'PENDING') {
            const refund = await this.provider.readRefund(run, leg, { settlePending });
            this.validateResult(leg, 'refund', refund);
            assert(refund.id === leg.refund.id, 'Refund reference changed during reconciliation.', 502);
            leg.refund = paymentReference(refund);
          }
          if(leg.refund?.status==='PENDING')pending=true;
          else if(leg.refundAmount>0&&leg.refund?.status!=='COMPLETED')unresolved=true;
        }else if(leg.authorization&&!leg.voided){await this.operation(run,leg,'void');leg.voided=true;}
        if(leg.reservation)leg.reservation.status='RELEASED';
        leg.recoveryError=null;
      }catch(error){leg.recoveryError=operationMessage(error);unresolved=true;this.store.event(run.id,'RECOVERY_UNRESOLVED',`${leg.seller}: ${leg.recoveryError}`);}
      this.save(run);
    }
    run.state=unresolved?'NEEDS_ATTENTION':pending?'REFUND_PENDING':'RECOVERED';this.save(run);
    this.store.event(run.id,run.state,run.state==='RECOVERED'?'Recovery confirmed. Any retained cancellation fees remain shown; refunds are not described as instant bank settlement.':run.state==='REFUND_PENDING'?'Some refunds are pending. The bundle is not described as fully recovered.':'Recovery is incomplete. Inspect the outstanding amount and operation records.');
    return this.view(run);
  }
  async recover(id,owner){return this.locked(id,async()=>{
    const run=this.owned(id,owner);
    assert(['READY','AWAITING_APPROVAL','PREPARING','RUNNING','OUTCOME_UNKNOWN','RECOVERY_REQUIRED','RECOVERING','NEEDS_ATTENTION','REFUND_PENDING','RECOVERED'].includes(run.state),'This bundle cannot be unwound in its current state.',409);
    return this.recoverInternal(run);
  });}
  async reconcile(id,owner){return this.locked(id,async()=>{
    const run=this.owned(id,owner);this.checkManifest(run);
    for(const leg of run.legs){
      const op=this.store.op(`${run.id}:${leg.category}:capture`);
      if(['STARTED','UNKNOWN'].includes(op?.status)||leg.capture?.status==='PENDING'){
        try {
          const observed=paymentReference(await this.provider.observe(run,leg,'capture'));
          if(!observed)continue;
          this.validateResult(leg,'capture',observed);
          if(op)this.store.putOp({...op,status:'SUCCEEDED',error:undefined,result:observed});
          leg.capture=observed;
          this.store.event(id,'RECONCILED',`${leg.seller}: capture found in provider records.`,{providerId:observed.id,status:observed.status});
        } catch(error) {
          this.store.event(id,'RECONCILIATION_WAIT',operationMessage(error));
        }
      }
    }
    this.save(run);
    if(['REFUND_PENDING','NEEDS_ATTENTION','RECOVERING'].includes(run.state))return this.recoverInternal(run,{settlePending:run.mode==='simulation'});
    if(run.state==='OUTCOME_UNKNOWN'&&run.legs.some(leg=>captureRejected(leg.capture))){
      run.state='RECOVERY_REQUIRED';
      run.recoveryReason='A provider declined a capture. Recover the remaining payment holds and any completed captures.';
      this.save(run);
    }
    if(run.state==='OUTCOME_UNKNOWN'&&run.legs.every(x=>{const op=this.store.op(`${run.id}:${x.category}:capture`);return (!op||op.status==='SUCCEEDED')&&(!x.capture||x.capture.status==='COMPLETED');})){
      run.state='READY';run.recoveryReason=null;this.save(run);this.store.event(id,'READY','Known captures were preserved. Continue the remaining operations using the same bundle.');
    }
    return this.view(run);
  });}
}

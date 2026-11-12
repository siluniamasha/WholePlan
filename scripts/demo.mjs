import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Simulator } from '../src/providers.mjs';
import { SCENARIOS } from '../src/domain.mjs';

const evidence={generatedAt:new Date().toISOString(),notice:'Actual local simulation executions. No PayPal or AI provider was called; all supplier inventory is fictional.',scenarios:[]};
for(const scenario of Object.keys(SCENARIOS)){
  const store=new Store(':memory:');
  try{
    const engine=new Engine({store,provider:new Simulator(store)});
    let run=engine.create('evidence-runner',{brief:'A concert ticket, a room, and a return shuttle.',budget:30000,maxLoss:0,scenario,interpretation:{source:'rules',model:null,summary:'Fixed demonstration itinerary',categories:['ticket','hotel','shuttle'],evidence:[]}});
    const transitions=[run.state];
    run=await engine.prepare(run.id,'evidence-runner',run.manifestHash);transitions.push(run.state);
    run=await engine.commit(run.id,'evidence-runner',run.manifestHash);transitions.push(run.state);
    if(scenario==='lost_response'){run=await engine.reconcile(run.id,'evidence-runner');transitions.push(run.state);run=await engine.commit(run.id,'evidence-runner',run.manifestHash);transitions.push(run.state);}
    else if(run.state==='RECOVERY_REQUIRED'){run=await engine.recover(run.id,'evidence-runner');transitions.push(run.state);if(run.state==='REFUND_PENDING'){run=await engine.reconcile(run.id,'evidence-runner');transitions.push(run.state);}}
    evidence.scenarios.push({scenario,transitions,providerCaptureEffects:store.effects(run.id).filter(x=>x.action==='capture').length,run});
    console.log(`${scenario}: ${transitions.join(' -> ')} | net confirmed charged $${(run.summary.netCharged/100).toFixed(2)}`);
  }finally{store.close();}
}
mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/scenarios.json',JSON.stringify(evidence,null,2));
console.log('Saved artifacts/scenarios.json — simulation only.');

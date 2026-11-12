import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Simulator, PayPalSandbox } from './providers.mjs';
import { AppError, assert, SCENARIOS, CATALOG } from './domain.mjs';
import { interpretBrief } from './ai.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT??4317);
const origin=process.env.PUBLIC_ORIGIN??`http://localhost:${port}`;
assert(['http:','https:'].includes(new URL(origin).protocol),'PUBLIC_ORIGIN must be an HTTP origin.');
const mode=process.env.PAYMENT_MODE??'simulation';
assert(['simulation','sandbox'].includes(mode),'PAYMENT_MODE must be simulation or sandbox. There is no live mode.');
const credentials=Object.fromEntries(['ticket','hotel','shuttle'].map(category=>[category,{id:process.env[`PAYPAL_${category.toUpperCase()}_CLIENT_ID`],secret:process.env[`PAYPAL_${category.toUpperCase()}_CLIENT_SECRET`]}]));
if(mode==='sandbox')assert(Object.values(credentials).every(x=>x.id&&x.secret),'Configure all three Sandbox seller apps before selecting sandbox mode.');
const store=new Store(process.env.WHOLEPLAN_DB??join(root,'data','wholeplan.sqlite'));
const provider=mode==='simulation'?new Simulator(store):new PayPalSandbox({credentials,origin});
const engine=new Engine({store,provider});
const ai={apiKey:process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL??'gemini-2.5-flash'};
const assets={'/':'index.html','/app.mjs':'app.mjs','/style.css':'style.css'};
const attempts=new Map();
function rateLimit(session){const now=Date.now();const item=attempts.get(session)??{start:now,n:0};if(now-item.start>60000){item.start=now;item.n=0;}assert(++item.n<=60,'Too many requests. Wait a minute.',429);attempts.set(session,item);if(attempts.size>10000)for(const [k,v]of attempts)if(now-v.start>120000)attempts.delete(k);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;assert(Buffer.byteLength(text)<=16384,'Request is too large.',413);}try{return JSON.parse(text||'{}');}catch{throw new AppError('Invalid JSON body.');}}

const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&assets[url.pathname]){
      const file=assets[url.pathname];res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.mjs')?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(await readFile(join(root,'public',file)));return;
    }
    if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(url.pathname==='/health'){json(res,200,{ok:true,mode});return;}
    const sid=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('wholeplan='))?.slice(10);
    let session=sid&&/^[a-f0-9-]{36}$/.test(sid)?store.session(sid):null;
    if(!session){const id=randomUUID(),csrf=randomUUID();store.putSession(id,csrf);session=store.session(id);res.setHeader('Set-Cookie',`wholeplan=${id}; HttpOnly; SameSite=Lax; Path=/${new URL(origin).protocol==='https:'?'; Secure':''}`);}
    if(req.method==='POST'){
      assert(req.headers['content-type']?.startsWith('application/json'),'Use JSON requests.',415);
      assert(!req.headers.origin||req.headers.origin===origin,'Origin is not allowed.',403);
      assert(equal(req.headers['x-csrf-token'],session.csrf),'Request verification failed. Reload the page.',403);
      rateLimit(session.id);
    }
    if(req.method==='GET'&&url.pathname==='/api/session'){
      json(res,200,{csrf:session.csrf,mode,aiConfigured:!!ai.apiKey,model:ai.model,sandboxConfigured:Object.values(credentials).every(x=>x.id&&x.secret),scenarios:SCENARIOS,catalog:CATALOG,limits:{suppliers:'Simulated inventory; one person to six travelers; fictional USD quotes.',payments:mode==='sandbox'?'Real PayPal Sandbox calls. Test funds only. Separate seller approval required.':'Local simulation. No PayPal account is contacted.',ai:ai.apiKey?'Gemini intake is configured; results still require review.':'Rule-based demo intake. No model is configured.'}});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/plans'){
      const b=await body(req);assert(typeof b.brief==='string'&&b.brief.length>=5&&b.brief.length<=4000,'Provide a brief of 5–4000 characters.');
      const interpretation=await interpretBrief(b.brief,b.useRules===true?{}:ai);
      json(res,201,engine.create(session.id,{...b,interpretation}));return;
    }
    const match=/^\/api\/runs\/([a-f0-9-]{36})(?:\/(prepare|commit|recover|reconcile|evidence))?$/.exec(url.pathname);
    if(match){
      const [,id,action]=match;
      if(req.method==='GET'&&!action){json(res,200,engine.view(engine.owned(id,session.id)));return;}
      if(req.method==='GET'&&action==='evidence'){
        const run=engine.owned(id,session.id);
        res.setHeader('Content-Disposition',`attachment; filename="wholeplan-${id.slice(0,8)}.json"`);
        json(res,200,{exportedAt:new Date().toISOString(),notice:'Demonstration evidence, not a security certification. Supplier inventory is simulated. Payment mode and AI source are explicit.',...engine.view(run)});return;
      }
      if(req.method==='POST'&&action){const b=await body(req);const result=action==='prepare'?await engine.prepare(id,session.id,b.manifestHash):action==='commit'?await engine.commit(id,session.id,b.manifestHash):action==='recover'?await engine.recover(id,session.id):action==='reconcile'?await engine.reconcile(id,session.id):null;assert(result,'Unsupported action.',404);json(res,200,result);return;}
    }
    if(req.method==='GET'&&url.pathname==='/paypal/return'){
      const runId=url.searchParams.get('run'),leg=url.searchParams.get('leg');
      await engine.approveSeller(runId,session.id,leg,{state:url.searchParams.get('state'),token:url.searchParams.get('token')});
      res.writeHead(303,{Location:`/#run=${encodeURIComponent(runId)}`});res.end();return;
    }
    if(req.method==='GET'&&url.pathname==='/paypal/cancel'){
      const runId=url.searchParams.get('run');engine.owned(runId,session.id);
      res.writeHead(303,{Location:`/#run=${encodeURIComponent(runId)}`});res.end();return;
    }
    throw new AppError('Not found.',404);
  }catch(error){if(!res.headersSent)json(res,error.status??500,{error:error.status?error.message:'Unexpected server error. Your saved operation records are retained.',code:error.code??'SERVER_ERROR'});else res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`WholePlan: ${origin} | payments=${mode} | AI=${ai.apiKey?'Gemini configured':'labelled rule-based fallback'} | inventory=simulated`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));

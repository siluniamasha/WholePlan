import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

test('HTTP journey: browser session, CSRF, isolation, planner, recovery and export',async t=>{
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`,dir=mkdtempSync(join(tmpdir(),'wholeplan-http-'));
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:origin,PAYMENT_MODE:'simulation',GEMINI_API_KEY:'test-disabled',AI_REQUESTS_PER_HOUR:'0',WHOLEPLAN_DB:join(dir,'test.sqlite')},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill();if(child.exitCode===null)await once(child,'exit');rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out')),10000);child.stdout.on('data',d=>{if(String(d).includes('WholePlan:')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}`));});});
  const session=await fetch(`${origin}/api/session`),cookie=session.headers.get('set-cookie').split(';')[0],config=await session.json();
  assert.equal(config.mode,'simulation');assert.equal(config.aiConfigured,true);assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const headers={'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':config.csrf,Origin:origin};
  const call=(path,body,extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await call('/api/plans',{}, {'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await call('/api/plans',{}, {Origin:'https://untrusted.example'})).status,403);
  const input={brief:'A concert ticket, a room and a shuttle.',budget:30000,maxLoss:0,travelers:1,scenario:'supplier_failure',useRules:true};
  assert.equal((await call('/api/plans',{...input,useRules:false})).status,429);
  for (const field of ['travelers', 'scenario']) {
    assert.equal((await call('/api/plans', { ...input, useRules: false, [field]: null })).status, 400);
  }
  assert.equal((await call('/api/plans',{...input,budget:-1})).status,400);
  let result=await call('/api/plans',input);assert.equal(result.status,201);let run=await result.json();assert.equal(run.state,'DRAFT');assert.equal(run.interpretation.source,'rules');assert.equal(run.legs[0].callbackState,undefined);
  const path=`/api/runs/${run.id}`;
  assert.equal((await fetch(origin+path)).status,403);
  const otherSession = await fetch(origin + '/api/session');
  const otherCookie = otherSession.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin + path, { headers: { Cookie: otherCookie } })).status, 404);
  assert.equal((await call(`${path}/prepare`,{manifestHash:'tampered'})).status,409);
  result=await call(`${path}/prepare`,{manifestHash:run.manifestHash});run=await result.json();assert.equal(run.state,'READY');
  run=await (await call(`${path}/commit`,{manifestHash:run.manifestHash})).json();assert.equal(run.state,'RECOVERY_REQUIRED');
  run=await (await call(`${path}/recover`,{})).json();assert.equal(run.state,'RECOVERED');assert.equal(run.summary.netCharged,0);assert.equal(run.summary.refunded,8000);
  const evidence=await fetch(`${origin}${path}/evidence`,{headers:{Cookie:cookie}});assert.equal(evidence.status,200);assert.match(evidence.headers.get('content-disposition'),/attachment/);assert.equal((await evidence.json()).state,'RECOVERED');
  const index=await fetch(origin);assert.equal(index.status,200);assert.match(index.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await index.text(),/Every piece/);
  const workspace = await fetch(origin + '/app');
  assert.match(workspace.headers.get('x-robots-tag'), /noindex/);
  assert.match(await workspace.text(), /id="plan-form"/);
  assert.equal(run.owner, undefined);
  const exported = await (await fetch(origin + path + '/evidence', { headers: { Cookie: cookie } })).json();
  assert.ok(!JSON.stringify(exported).includes(cookie.slice('wholeplan='.length)));
  assert.equal(exported.owner, undefined);
  for (const invalidBody of [null, [], 'string', 123, false]) {
    assert.equal((await call('/api/plans', invalidBody)).status, 400);
  }
  for (const scenario of ['__proto__', 'constructor']) {
    assert.equal((await call('/api/plans', { ...input, scenario })).status, 400);
  }
  assert.equal((await call('/api/plans', input, { 'Content-Type': 'application/jsonp' })).status, 415);
  assert.equal((await call('/api/plans', input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/plans', { ...input, brief: 'a'.repeat(17000) })).status, 413);
  const malformed = await fetch(origin + '/api/plans', { method: 'POST', headers, body: '{invalid' });
  assert.equal(malformed.status, 400);
  for (const privatePath of ['/.env', '/.git/config', '/src/server.mjs', '/data/wholeplan.sqlite', '/.local-backup/']) {
    const response = await fetch(origin + privatePath);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const robots = await (await fetch(origin + '/robots.txt')).text();
  assert.ok(robots.includes('Disallow: /api/'));
  const sitemap = await (await fetch(origin + '/sitemap.xml')).text();
  assert.ok(sitemap.includes(origin + '/</loc>'));
  assert.ok(!sitemap.includes('/app'));
  const home = await (await fetch(origin)).text();
  assert.ok(home.includes('rel="canonical" href="' + origin + '/"'));
  assert.ok(!home.includes('{{PUBLIC_ORIGIN}}'));
  const missingPage = await fetch(origin + '/missing-page', { headers: { Accept: 'text/html' } });
  assert.equal(missingPage.status, 404);
  assert.match(missingPage.headers.get('content-type'), /text\/html/);
  assert.match(await missingPage.text(), /Open your workspace/);
  const socialImage = await fetch(origin + '/social.png');
  assert.equal(socialImage.status, 200);
  assert.equal(socialImage.headers.get('content-type'), 'image/png');
  const generatedAssets = [
    ['wholeplan-mark.png', 'image/png'],
    ['favicon-64.png', 'image/png'],
    ['apple-touch-icon.png', 'image/png'],
    ['wholeplan-hero.webp', 'image/webp'],
    ['wholeplan-hero-640.webp', 'image/webp'],
    ['wholeplan-social.png', 'image/png'],
  ];
  for (const [filename, contentType] of generatedAssets) {
    const asset = await fetch(origin + '/assets/' + filename);
    assert.equal(asset.status, 200, filename);
    assert.equal(asset.headers.get('content-type'), contentType);
    assert.ok((await asset.arrayBuffer()).byteLength > 100);
  }
  assert.ok(home.includes('/assets/wholeplan-hero-640.webp 640w'));
  assert.ok(home.includes('/assets/wholeplan-social.png'));
  assert.equal((await fetch(`${origin}/style.css`)).status,200);assert.equal((await fetch(`${origin}/app.mjs`)).status,200);
});

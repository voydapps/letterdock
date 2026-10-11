// Headless check of the website screenshot viewer:  node scripts/test-site-viewer.mjs <out-dir>  (writes viewer-<width>.png)
// 13 pictures: the hero and the 12 feature tiles. The tile pictures sit in closed <details> and load only when opened.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('site');
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
const srv = http.createServer((q,r)=>{ let p=q.url.split('?')[0]; if(p.endsWith('/'))p+='index.html'; const f=path.join(root,p); if(!fs.existsSync(f)){r.statusCode=404;return r.end();} r.setHeader('content-type',types[path.extname(f)]||'application/octet-stream'); r.end(fs.readFileSync(f)); }).listen(0);
const base = `http://localhost:${srv.address().port}/`;
const out = process.argv[2];
const b = await chromium.launch();
const errs=[], ext=[]; let shotReq=[]; let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok',m); };
for (const [w,h,scheme] of [[1440,900,'light'],[375,812,'dark'],[320,640,'light'],[1920,1080,'dark']]) {
  const ctx = await b.newContext({viewport:{width:w,height:h},colorScheme:scheme,hasTouch:w<500});
  const pg = await ctx.newPage();
  pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())}); pg.on('pageerror',e=>errs.push(String(e)));
  pg.on('request',r=>{ if(/\/screenshots\/(?!hero)/.test(r.url())) shotReq.push(r.url()); if(!r.url().startsWith(base)&&!r.url().startsWith('data:')) ext.push(r.url()); });
  shotReq.length=0; await pg.goto(base);
  ok(await pg.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `${w}: no horizontal scroll`);
  const n = await pg.locator('a.zoom').count(); ok(n===13, `${w}: 13 zoom links (${n})`);
  ok(shotReq.length===0, `${w}: no feature picture requested before a tile is opened (${shotReq.length})`);
  const SEND = 4; // 0 hero, 1 unified inbox, 2 conversations, 3 search, 4 send later
  const third = pg.locator('a.zoom').nth(SEND);
  ok((await third.getAttribute('aria-label')).endsWith('Send later'), `${w}: link ${SEND} is Send later`);
  await third.evaluate(a=>a.closest('details').querySelector('summary').scrollIntoView({block:'center'}));
  await third.evaluate(a=>a.closest('details').querySelector('summary').focus());
  await pg.keyboard.press('Enter'); // opens the tile (a closed tile hides its link)
  await pg.waitForFunction(()=>document.querySelectorAll('details.tile[open]').length===1);
  await third.focus();
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('dialog.viewer[open]');
  await pg.waitForFunction(()=>{const i=document.querySelector('.v-fig img');return i.complete&&i.naturalWidth>0});
  ok((await pg.textContent('.v-count'))==='5 / 13', `${w}: counter 5 / 13`);
  ok((await pg.textContent('figcaption'))==='Send later', `${w}: caption Send later`);
  ok(await pg.evaluate(()=>getComputedStyle(document.documentElement).overflow==='hidden'), `${w}: scroll locked`);
  const g = await pg.evaluate(()=>{const i=document.querySelector('.v-fig img').getBoundingClientRect();const c=document.querySelector('.v-close').getBoundingClientRect();const im=document.querySelector('.v-fig img');return {iw:i.width,ih:i.height,nw:im.naturalWidth,right:innerWidth-c.right,cw:c.width,ch:c.height,fits:i.bottom<=innerHeight&&i.right<=innerWidth,sw:document.documentElement.scrollWidth<=innerWidth}});
  console.log(JSON.stringify(g));
  ok(g.iw<=g.nw+1 && g.fits && g.cw>=44 && g.ch>=44, `${w}: image fits, not upscaled, close 44px`);
  await pg.waitForTimeout(400); await pg.screenshot({path:`${out}/viewer-${w}.png`});
  await pg.keyboard.press('ArrowRight'); ok((await pg.textContent('.v-count'))==='6 / 13', `${w}: right arrow`);
  await pg.keyboard.press('ArrowLeft'); await pg.keyboard.press('ArrowLeft'); ok((await pg.textContent('.v-count'))==='4 / 13', `${w}: left arrow`);
  await pg.click('.v-next'); ok((await pg.textContent('.v-count'))==='5 / 13', `${w}: next button`);
  for(let i=0;i<4;i++) await pg.keyboard.press('Tab');
  ok(await pg.evaluate(()=>!!document.activeElement.closest('dialog')), `${w}: focus trapped`);
  await pg.keyboard.press('Escape');
  await pg.waitForFunction(()=>!document.querySelector('dialog.viewer[open]'));
  ok(await pg.evaluate(()=>document.activeElement===document.querySelectorAll('a.zoom')[4]), `${w}: focus returned`);
  // backdrop + hero + wrap
  await pg.locator('a.zoom').first().click({force:true}); await pg.waitForSelector('dialog.viewer[open]');
  ok((await pg.textContent('.v-count'))==='1 / 13', `${w}: hero opens`);
  await pg.keyboard.press('ArrowLeft'); ok((await pg.textContent('.v-count'))==='13 / 13', `${w}: wraps to the last tile picture`);
  // That picture sits in a closed tile (never loaded): the viewer falls back to the link target, the full-size PNG.
  await pg.waitForFunction(()=>{const i=document.querySelector('.v-fig img');return i.complete&&i.naturalWidth>0});
  ok((await pg.textContent('figcaption'))==='Notifications and tray' && (await pg.getAttribute('.v-fig img','src')).endsWith('screenshots/full/notifications.png'), `${w}: closed-tile picture opens from its link`);
  await pg.mouse.click(w-3, h/2); await pg.waitForFunction(()=>!document.querySelector('dialog.viewer[open]'));
  ok(true, `${w}: backdrop closes`);
  ok(await pg.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `${w}: no h-scroll after`);
  await ctx.close();
}
// Overlay: an opened tile must not change the page layout (>= 600px); Esc closes it, but not while the viewer is open.
for (const [w,h,scheme] of [[1440,900,'light'],[1440,900,'dark'],[1024,800,'light'],[768,900,'light'],[600,900,'light'],[375,812,'light'],[320,640,'dark']]) {
  const ctx = await b.newContext({viewport:{width:w,height:h},colorScheme:scheme});
  const pg = await ctx.newPage(); await pg.goto(base);
  const m = ()=>pg.evaluate(()=>{const s=document.getElementById('features');const nx=s.nextElementSibling;return {sec:s.getBoundingClientRect().height,next:nx.getBoundingClientRect().top+scrollY,doc:document.documentElement.scrollHeight,sw:document.documentElement.scrollWidth<=innerWidth}});
  const closed = await m();
  const sum = pg.locator('details.tile summary').nth(3); // Send later
  await sum.scrollIntoViewIfNeeded(); await sum.click();
  await pg.waitForFunction(()=>document.querySelectorAll('details.tile[open]').length===1);
  await pg.waitForTimeout(300);
  const open = await m();
  console.log(w, scheme, 'closed', JSON.stringify(closed), 'open', JSON.stringify(open));
  if (w>=600) ok(closed.sec===open.sec && closed.next===open.next && closed.doc===open.doc, `${w} ${scheme}: no layout shift on open`);
  ok(open.sw, `${w} ${scheme}: no horizontal scroll when open`);
  const tag = `${w}-${scheme}`;
  if (out && (w===1440||w===375)) await pg.screenshot({path:`${out}/overlay-${tag}.png`});
  // panel not clipped: inside the viewport width
  ok(await pg.evaluate(()=>{const r=document.querySelector('details.tile[open] .more').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}), `${w} ${scheme}: panel inside the viewport`);
  // viewer from inside the panel; Esc closes the viewer, tile stays; focus back on the thumbnail
  await pg.locator('details.tile[open] a.zoom').click();
  await pg.waitForSelector('dialog.viewer[open]');
  await pg.keyboard.press('Escape');
  await pg.waitForFunction(()=>!document.querySelector('dialog.viewer[open]'));
  ok(await pg.evaluate(()=>document.querySelectorAll('details.tile[open]').length===1 && document.activeElement===document.querySelector('details.tile[open] a.zoom')), `${w} ${scheme}: Esc closes only the viewer, tile stays open, focus on thumbnail`);
  // viewer open, click on the dim backdrop must not close the tile either
  await pg.locator('details.tile[open] a.zoom').click(); await pg.waitForSelector('dialog.viewer[open]');
  await pg.mouse.click(w-3, h/2); await pg.waitForFunction(()=>!document.querySelector('dialog.viewer[open]'));
  ok(await pg.evaluate(()=>document.querySelectorAll('details.tile[open]').length===1), `${w} ${scheme}: backdrop click closes viewer only`);
  await pg.waitForFunction(()=>!document.documentElement.classList.contains('viewing'));
  // Esc now closes the tile and focuses its summary
  await pg.keyboard.press('Escape');
  ok(await pg.evaluate(()=>document.querySelectorAll('details.tile[open]').length===0 && document.activeElement.tagName==='SUMMARY'), `${w} ${scheme}: Esc closes the tile`);
  // click outside closes
  await sum.click(); await pg.waitForFunction(()=>document.querySelectorAll('details.tile[open]').length===1);
  await pg.mouse.click(5, 5);
  ok(await pg.evaluate(()=>document.querySelectorAll('details.tile[open]').length===0), `${w} ${scheme}: click outside closes`);
  // another tile closes the first
  await sum.click(); await pg.locator('details.tile summary').nth(5).evaluate(e=>e.focus()); await pg.keyboard.press('Enter');
  ok(await pg.evaluate(()=>document.querySelectorAll('details.tile[open]').length===1), `${w} ${scheme}: one tile open at a time`);
  await ctx.close();
}
// no JS
const c2 = await b.newContext({javaScriptEnabled:false}); const p2 = await c2.newPage(); await p2.goto(base);
ok((await p2.locator('a.zoom').first().getAttribute('href')).endsWith('.png'), 'nojs link to png');
console.log('errors',errs,'external',ext,'fails',fails);
await b.close(); srv.close();

// Tells Bing, Yandex, Seznam and Naver (IndexNow) that the site pages changed.  Run by hand after a deploy:
//
//   node scripts/indexnow-ping.mjs
//
// It sends the two page URLs and the sitemap URL to https://api.indexnow.org/indexnow. Nothing else is sent.
// The key is public on purpose: the file site/<KEY>.txt proves we own the site. 200 or 202 means accepted.
const KEY = '674aee96bad5f679e2afbb2a4ed99791';
const BASE = 'https://voydapps.github.io/letterdock/';
const body = {
  host: 'voydapps.github.io',
  key: KEY,
  keyLocation: `${BASE}${KEY}.txt`,
  urlList: [BASE, `${BASE}changelog.html`, `${BASE}sitemap.xml`],
};
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
console.log(`IndexNow answered ${res.status} ${res.statusText}`);
if (res.status !== 200 && res.status !== 202) process.exit(1);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxylog-'));
process.env.LOG_DIR = dir;
const { redactUpstreamUrl, pruneRotatedLogs, logProxyRequest, readProxyLogs } = require('../server/utils/proxyLogger');

test('keeps origin and short path, drops query and credentials', () => {
  assert.equal(
    redactUpstreamUrl('https://user:pw@addon.example.com:8443/catalog/movie/top.json?apikey=SECRETVALUE123'),
    'https://addon.example.com:8443/catalog/movie/top.json'
  );
});

test('replaces key-looking path segments', () => {
  const cfg = 'eyJpdiI6IkFBQUFBQUFBQUFBQUFBQUEiLCJlbmNyeXB0ZWQiOiJ4In0';
  assert.equal(
    redactUpstreamUrl(`https://aio.example.com/stremio/${cfg}/manifest.json`),
    'https://aio.example.com/stremio/:redacted/manifest.json'
  );
  assert.equal(
    redactUpstreamUrl('https://aio.example.com/stremio/0123456789abcdef0123456789abcdef/stream/movie/tt0111161.json'),
    'https://aio.example.com/stremio/:redacted/stream/movie/tt0111161.json'
  );
  assert.equal(redactUpstreamUrl('https://a.example.com/stream/movie/tt0111161.json'), 'https://a.example.com/stream/movie/tt0111161.json');
});

test('unparseable or empty values are dropped', () => {
  assert.equal(redactUpstreamUrl('not a url with key=abc'), null);
  assert.equal(redactUpstreamUrl(null), null);
});

test('logged entry and read-back never carry the secret', async () => {
  logProxyRequest({ addon: { id: 'a1' }, upstreamUrl: 'https://h.example.com/p?token=TOPSECRET' , method: 'GET' });
  await new Promise((r) => setTimeout(r, 100));
  const raw = fs.readFileSync(path.join(dir, 'proxy.log'), 'utf8');
  assert.ok(!raw.includes('TOPSECRET'));
  // an old line written before redaction is cleaned on read
  fs.appendFileSync(path.join(dir, 'proxy.log'), JSON.stringify({ addonId: 'a1', upstreamUrl: 'https://h.example.com/p?token=OLDSECRET' }) + '\n');
  const { logs } = await readProxyLogs({});
  assert.ok(logs.every((l) => !String(l.upstreamUrl).includes('OLDSECRET')));
});

test('only the newest rotated logs are kept', async () => {
  for (const ts of [1, 2, 3, 4, 5]) fs.writeFileSync(path.join(dir, `proxy.log.${ts}`), 'x');
  fs.writeFileSync(path.join(dir, 'proxy.log.keepme.txt'), 'x');
  await pruneRotatedLogs();
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('proxy.log.')).sort();
  assert.deepEqual(left, ['proxy.log.3', 'proxy.log.4', 'proxy.log.5', 'proxy.log.keepme.txt']);
});

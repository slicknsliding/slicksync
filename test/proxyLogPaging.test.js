const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxylog-page-'))
process.env.LOG_DIR = dir
const { readProxyLogs } = require('../server/utils/proxyLogger')

// 250 lines, oldest first, alternating between two addons, plus junk lines.
const lines = []
for (let i = 0; i < 250; i++) {
  lines.push(JSON.stringify({ n: i, addonId: i % 2 ? 'b' : 'a', accountId: 'acct', upstreamUrl: `https://addon.example.com/stream/movie/tt${i}.json?key=SECRET` }))
  if (i % 50 === 0) lines.push('not json')
}
fs.writeFileSync(path.join(dir, 'proxy.log'), lines.join('\n') + '\n\n')

test('newest first, paged, with the total of every match', async () => {
  const first = await readProxyLogs({ limit: 10 })
  assert.equal(first.total, 250)
  assert.deepEqual(first.logs.map((l) => l.n), [249, 248, 247, 246, 245, 244, 243, 242, 241, 240])
  const later = await readProxyLogs({ limit: 5, offset: 245 })
  assert.deepEqual(later.logs.map((l) => l.n), [4, 3, 2, 1, 0])
  const past = await readProxyLogs({ limit: 5, offset: 400 })
  assert.deepEqual(past.logs, [])
  assert.equal(past.total, 250)
})

test('filters apply before paging, and addresses come back redacted', async () => {
  const b = await readProxyLogs({ addonId: 'b', limit: 3, offset: 1 })
  assert.equal(b.total, 125)
  assert.deepEqual(b.logs.map((l) => l.n), [247, 245, 243])
  assert.ok(!b.logs[0].upstreamUrl.includes('SECRET'))
  const other = await readProxyLogs({ accountId: 'someone-else', limit: 10 })
  assert.equal(other.total, 0)
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

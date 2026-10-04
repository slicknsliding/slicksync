const test = require('node:test')
const assert = require('node:assert/strict')
const { syncOne } = require('../server/utils/jellyfinServerCollections')

// Stands in for a Jellyfin server's collection endpoints - and for the web,
// for a catalog cover's picture.
function fakeJellyfin() {
  const state = { collections: new Map(), next: 1, pictures: [], calls: [] }
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url)
    const method = opts.method || 'GET'
    if (u.host === 'covers.example') {
      return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => Buffer.from('png-bytes') }
    }
    state.calls.push(`${method} ${u.pathname}`)
    const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean)
    let body = null
    let status = 200
    let m
    if (method === 'POST' && u.pathname === '/Collections') {
      const id = `col${state.next++}`
      state.collections.set(id, { name: u.searchParams.get('name'), items: ids })
      body = { Id: id }
    } else if ((m = /^\/Collections\/([^/]+)\/Items$/.exec(u.pathname))) {
      const c = state.collections.get(m[1])
      c.items = method === 'POST' ? [...c.items, ...ids] : c.items.filter((i) => !ids.includes(i))
      status = 204
    } else if ((m = /^\/Items\/([^/]+)\/Images\/Primary$/.exec(u.pathname))) {
      state.pictures.push({ id: m[1], method, type: opts.headers?.['Content-Type'] })
      status = 204
    } else if ((m = /^\/Items\/([^/]+)$/.exec(u.pathname))) {
      const c = state.collections.get(m[1])
      if (!c) status = 404
      else if (method === 'GET') body = { Id: m[1], Type: 'BoxSet', Name: c.name }
      else if (method === 'POST') { c.name = JSON.parse(opts.body).Name; status = 204 }
      else if (method === 'DELETE') { state.collections.delete(m[1]); status = 204 }
    } else if (u.pathname === '/Items' && u.searchParams.get('ParentId')) {
      const c = state.collections.get(u.searchParams.get('ParentId'))
      body = { Items: (c?.items || []).map((Id) => ({ Id })) }
    }
    const text = body ? JSON.stringify(body) : ''
    return { ok: status < 400, status, text: async () => text }
  }
  return state
}

const s = { base: 'http://jf.example', userId: 'u1', token: 't', deviceId: 'd' }
const index = new Map([['tt1', 'a'], ['tt2', 'b'], ['tt3', 'c']])
const list = (ids, extra = {}) => ({ id: 'L', name: 'Mysteries', itemsJson: JSON.stringify(ids.map((id) => ({ id }))), coverImageUrl: null, ...extra })

test('makes a collection of only the titles the server has', async () => {
  const jf = fakeJellyfin()
  const r = await syncOne(s, list(['tt1', 'tt9', 'tt3']), index, {})
  assert.equal(r.matched, 2)
  assert.deepEqual(jf.collections.get(r.collectionId), { name: 'Mysteries', items: ['a', 'c'] })
})

test('keeps it in step: adds new titles, takes out removed ones', async () => {
  const jf = fakeJellyfin()
  const first = await syncOne(s, list(['tt1', 'tt3']), index, {})
  const again = await syncOne(s, list(['tt2', 'tt3']), index, { collectionId: first.collectionId })
  assert.equal(again.collectionId, first.collectionId)
  assert.deepEqual([...jf.collections.get(first.collectionId).items].sort(), ['b', 'c'])
})

test('nothing of it on the server: no empty collection', async () => {
  const jf = fakeJellyfin()
  const r = await syncOne(s, list(['tt7', 'tt8']), index, {})
  assert.equal(r.collectionId, null)
  assert.equal(r.matched, 0)
  assert.equal(jf.collections.size, 0)
})

test('a collection deleted on the server is made again', async () => {
  const jf = fakeJellyfin()
  const r = await syncOne(s, list(['tt1']), index, { collectionId: 'gone' })
  assert.notEqual(r.collectionId, 'gone')
  assert.equal(jf.collections.size, 1)
})

test('renamed catalog, as an administrator: renamed in place', async () => {
  const jf = fakeJellyfin()
  const first = await syncOne(s, list(['tt1', 'tt2']), index, {}, { admin: true })
  const r = await syncOne(s, list(['tt1', 'tt2'], { name: 'Whodunits' }), index, first, { admin: true })
  assert.equal(r.collectionId, first.collectionId)
  assert.equal(jf.collections.get(r.collectionId).name, 'Whodunits')
})

test('renamed catalog, without an administrator: made again under the new name', async () => {
  const jf = fakeJellyfin()
  const first = await syncOne(s, list(['tt1', 'tt2']), index, {})
  const r = await syncOne(s, list(['tt1', 'tt2'], { name: 'Whodunits' }), index, first)
  assert.notEqual(r.collectionId, first.collectionId)
  assert.equal(jf.collections.has(first.collectionId), false)
  assert.deepEqual(jf.collections.get(r.collectionId), { name: 'Whodunits', items: ['a', 'b'] })
})

test('catalog cover goes on the collection once, as an administrator only', async () => {
  const jf = fakeJellyfin()
  const withCover = list(['tt1'], { coverImageUrl: 'https://covers.example/x.png' })
  const first = await syncOne(s, withCover, index, {}, { admin: true })
  assert.equal(first.cover, 'https://covers.example/x.png')
  assert.deepEqual(jf.pictures, [{ id: first.collectionId, method: 'POST', type: 'image/png' }])

  await syncOne(s, withCover, index, first, { admin: true })
  assert.equal(jf.pictures.length, 1)

  const off = await syncOne(s, list(['tt1']), index, first, { admin: true })
  assert.equal(off.cover, null)
  assert.equal(jf.pictures.at(-1).method, 'DELETE')

  const jf2 = fakeJellyfin()
  const manager = await syncOne(s, withCover, index, {})
  assert.equal(manager.cover, null)
  assert.equal(jf2.pictures.length, 0)
})

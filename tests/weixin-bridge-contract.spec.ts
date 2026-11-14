/**
 * Cross-process HTTP contract tests for the two new WeChat backends.
 *
 * The frozen contract is `sidecar/wxauto-bridge/contract.md`; this file drives each new sidecar over real HTTP from
 * its own child process, with no WeChat client and no real account:
 *
 *   - `sidecar/weixin-db-bridge` (backend `pc-db`, Python): started with `--fake`, the deterministic backend its own
 *     `selftest.py` uses, so the standard-library server answers on any OS.
 *   - `sidecar/weixin-ilink-bridge` (backend `ilink`, Node): started with `run` pointed at a mock iLink server built in
 *     this file (getUpdates / sendmessage / CDN download), so the vendored client has something to talk to.
 *
 * Covered per contract: 200 endpoint shapes (`/health` `/status` `/rooms` `/members` `/messages` `/media` `/send`
 * `/listen`), 400 (bad body), 401 (missing/wrong token), 404 (unknown path / unknown media id), 405 (wrong method with
 * `Allow`), 501 (capability the backend does not have), event fields (§3), cursor paging (§4), media bytes with the
 * zero-byte rule (§5), and token hygiene (the bearer token never reaches the child's output).
 *
 * A suite is skipped when its sidecar file is absent or its interpreter is unavailable, so the default `vitest run`
 * stays green on a box that only checks the pure TS layer.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const TEST_TIMEOUT_MS = 30_000

/** The first Python that actually runs; the Microsoft Store `python3` alias on Windows exits non-zero. */
function resolvePython(): string | undefined {
  for (const candidate of [process.env.PYTHON, 'python3', 'python']) {
    if (!candidate) continue
    try {
      if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate
    } catch { /* try the next candidate */ }
  }
  return undefined
}

/** Whether a child is still accepting connections on `port` (proves no listener is left behind). */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve_ => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve_(true) })
    socket.setTimeout(500, () => { socket.destroy(); resolve_(false) })
    socket.on('error', () => { socket.destroy(); resolve_(false) })
  })
}

interface Reply { status: number; headers: Headers; json: any; bytes: Buffer; text: string }

/** One request against a sidecar; JSON is parsed only when the server says it served JSON. */
async function call(
  baseUrl: string,
  token: string | null,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  let body: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json'
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET', headers, body, signal: AbortSignal.timeout(15_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  let json: any
  if (contentType.includes('application/json')) {
    try { json = JSON.parse(bytes.toString('utf8')) } catch { json = undefined }
  }
  return { status: response.status, headers: response.headers, json, bytes, text: bytes.toString('utf8') }
}

/** Polls `probe` until it reports ready or `capMs` elapses. */
async function waitUntil(probe: () => Promise<boolean>, capMs: number, label: string): Promise<void> {
  const deadline = Date.now() + capMs
  let delay = 50
  while (Date.now() < deadline) {
    try { if (await probe()) return } catch { /* the port is not listening yet */ }
    await new Promise(resolve_ => setTimeout(resolve_, delay))
    delay = Math.min(delay * 2, 500)
  }
  throw new Error(`${label} did not become ready within ${capMs}ms`)
}

/** A fresh random loopback port in 18100-18999. */
const pickPort = (): number => 18_100 + Math.floor(Math.random() * 900)

/** Spawns a sidecar, keeping the tail of its stderr for token-hygiene assertions. */
function spawnSidecar(command: string, args: string[]): { child: ChildProcess; stderr: () => string } {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-50_000) })
  return { child, stderr: () => stderr }
}

/** Stops a child: SIGTERM, then SIGKILL when it lingers, always waiting for the exit. */
async function stopSidecar(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve_ => {
    const escalate = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } resolve_() }, 5_000)
    child.once('exit', () => { clearTimeout(escalate); resolve_() })
    try { child.kill('SIGTERM') } catch { clearTimeout(escalate); resolve_() }
  })
}

// ===========================================================================
// pc-db backend (sidecar/weixin-db-bridge, Python --fake)
// ===========================================================================

const DB_SERVER = resolve(REPO, 'sidecar', 'weixin-db-bridge', 'server.py')
const PYTHON = resolvePython()
const DB_READY = existsSync(DB_SERVER) && PYTHON !== undefined

const DB_SELF = 'wxid_fake_self'
const DB_GROUP = 'chatroom_fake_dev'
const DB_GROUP_NAME = '研发-交付群'
const DB_SINGLE = 'wxid_fake_alice'

describe.skipIf(!DB_READY)('weixin-db-bridge (pc-db) HTTP contract — fake backend', () => {
  const TOKEN = `db-contract-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  let child: ChildProcess | undefined
  let stderrOf = () => ''
  let port = 0
  let base = ''

  beforeAll(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 5 && !base; attempt += 1) {
      port = pickPort()
      const spawned = spawnSidecar(PYTHON!, [DB_SERVER, '--fake', '--port', String(port), '--token', TOKEN, '--quiet'])
      child = spawned.child
      stderrOf = spawned.stderr
      try {
        await waitUntil(async () => (await call(`http://127.0.0.1:${port}`, TOKEN, '/health')).json?.ok === true, 10_000, 'db bridge')
        base = `http://127.0.0.1:${port}`
      } catch (error) {
        lastError = error
        await stopSidecar(child)
        child = undefined
      }
    }
    if (!base) throw lastError ?? new Error('the db bridge did not start')
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await stopSidecar(child)
    if (port) {
      let closed = false
      for (let attempt = 0; attempt < 10 && !closed; attempt += 1) {
        closed = !(await isPortOpen(port))
        if (!closed) await new Promise(resolve_ => setTimeout(resolve_, 200))
      }
      expect(closed, `the db bridge still listens on 127.0.0.1:${port} after cleanup`).toBe(true)
    }
  }, TEST_TIMEOUT_MS)

  it('serves /health 200 with a truthful capability report (members full, mentions none, media on)', async () => {
    const reply = await call(base, TOKEN, '/health')
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, available: true, backend: 'pc-db', sidecar: '1' })
    expect(typeof reply.json.version).toBe('string')
    expect(reply.json.capabilities).toMatchObject({ members: 'full', media: true })
    expect(['none', 'markup']).toContain(reply.json.capabilities.mentions)
    expect(typeof reply.json.uptimeSec).toBe('number')
  })

  it('serves /status 200 with the account identity and client version', async () => {
    const reply = await call(base, TOKEN, '/status')
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ loggedIn: true, wxid: DB_SELF, backend: 'pc-db' })
    expect(typeof reply.json.name).toBe('string')
    expect(typeof reply.json.client).toBe('string')
  })

  it('lists group and single-chat rooms, and serves full members for a group', async () => {
    const rooms = await call(base, TOKEN, '/rooms')
    expect(rooms.status).toBe(200)
    const ids = (rooms.json.rooms as { id: string }[]).map(room => room.id)
    expect(ids).toContain(DB_GROUP)
    expect(ids).toContain(DB_SINGLE)
    expect((rooms.json.rooms as { name: string }[]).map(room => room.name)).toContain(DB_GROUP_NAME)

    const members = await call(base, TOKEN, `/members?room=${encodeURIComponent(DB_GROUP)}`)
    expect(members.status).toBe(200)
    expect(members.json.members).toContainEqual({ id: DB_SELF, name: '智能助手' })
    expect(members.json.members).toContainEqual({ id: 'wxid_fake_alice', name: '阿黎' })
    // Unknown room is an empty list, not an error (contract §3).
    const missing = await call(base, TOKEN, '/members?room=chatroom_missing')
    expect(missing.status).toBe(200)
    expect(missing.json.members).toEqual([])
  })

  it('serves /messages with every §3 event field, paging on the opaque cursor', async () => {
    const page = await call(base, TOKEN, `/messages?room=${encodeURIComponent(DB_GROUP)}&limit=50`)
    expect(page.status).toBe(200)
    const events = page.json.events as any[]
    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(typeof page.json.next).toBe('string')
    expect(typeof page.json.head).toBe('string')

    for (const event of events) {
      expect(event).toHaveProperty('nativeId')
      expect(event).toHaveProperty('room', DB_GROUP)
      expect(typeof event.sender?.id).toBe('string')
      expect(typeof event.sender?.name).toBe('string')
      // text is never the empty string (contract §3.2).
      expect(typeof event.text).toBe('string')
      expect(event.text.length).toBeGreaterThan(0)
      expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(Array.isArray(event.ats)).toBe(true)
      expect(typeof event.own).toBe('boolean')
      expect(typeof event.quoteId).toBe('string')
      expect(Array.isArray(event.media)).toBe(true)
    }
    // nativeId is the dedupe key, so it must be unique within a page.
    const nativeIds = events.map(event => event.nativeId)
    expect(new Set(nativeIds).size).toBe(nativeIds.length)

    // The image event lists a downloadable id `<nativeId>#<index>` with kind image.
    const withMedia = events.find(event => event.media.length > 0)
    expect(withMedia).toBeTruthy()
    expect(withMedia.media[0]).toMatchObject({ kind: 'image' })
    expect(withMedia.media[0].id).toMatch(/#0$/)

    // Cursor semantics (§4): reading on from `next` returns no new events and keeps `next` unchanged.
    const tail = await call(base, TOKEN, `/messages?room=${encodeURIComponent(DB_GROUP)}&cursor=${encodeURIComponent(page.json.next)}`)
    expect(tail.status).toBe(200)
    expect(tail.json.events).toEqual([])
    expect(tail.json.next).toBe(page.json.next)

    // A direct message carries `room: ""` (contract §3); the server merges all direct chats into that one stream.
    const direct = await call(base, TOKEN, '/messages?room=&limit=50')
    expect(direct.status).toBe(200)
    for (const event of direct.json.events as any[]) expect(event.room).toBe('')
  })

  it('downloads a message image as PNG bytes, and answers 404 (not 200+0) for an unknown id', async () => {
    const page = await call(base, TOKEN, `/messages?room=${encodeURIComponent(DB_GROUP)}&limit=50`)
    const withMedia = (page.json.events as any[]).find(event => event.media.length > 0)!
    const mediaId: string = withMedia.media[0].id

    const image = await call(base, TOKEN, `/media/${encodeURIComponent(mediaId)}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type') ?? '').toMatch(/^image\//)
    expect(image.bytes.byteLength).toBeGreaterThan(8)
    // PNG magic — the zero-byte rule says an empty payload is a 404, so a 200 always carries real bytes.
    expect([...image.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const missing = await call(base, TOKEN, '/media/does-not-exist%230')
    expect(missing.status).toBe(404)
    expect(missing.json).toMatchObject({ error: 'not_found' })
  })

  it('answers /send 501 (read-only backend) and /listen with resolved, failed, and empty sets', async () => {
    const send = await call(base, TOKEN, '/send', { method: 'POST', body: { room: DB_GROUP, wxid: 'x', text: 'hi' } })
    expect(send.status).toBe(501)
    expect(send.json).toMatchObject({ error: 'unsupported' })

    const known = await call(base, TOKEN, '/listen', { method: 'POST', body: { rooms: [DB_GROUP] } })
    expect(known.status).toBe(200)
    expect((known.json.listening as any[]).map(room => room.id)).toContain(DB_GROUP)

    const unknown = await call(base, TOKEN, '/listen', { method: 'POST', body: { rooms: ['chatroom_missing'] } })
    expect(unknown.status).toBe(200)
    expect((unknown.json.failed as any[]).map(entry => entry.room)).toEqual(['chatroom_missing'])

    const empty = await call(base, TOKEN, '/listen', { method: 'POST', body: { rooms: [] } })
    expect(empty.status).toBe(200)
    expect(empty.json.listening).toEqual([])
  })

  it('enforces auth (401), routing (404), method (405 + Allow), and body validation (400)', async () => {
    expect((await call(base, null, '/health')).status).toBe(401)
    expect((await call(base, 'wrong-token', '/health')).json).toMatchObject({ error: 'unauthorized' })

    const unknownPath = await call(base, TOKEN, '/does-not-exist')
    expect(unknownPath.status).toBe(404)
    expect(unknownPath.json).toMatchObject({ error: 'not_found' })

    const wrongMethod = await call(base, TOKEN, '/send')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow') ?? '').toContain('POST')

    const badJson = await call(base, TOKEN, '/send', { method: 'POST', body: '{not json' })
    expect(badJson.status).toBe(400)
    expect(badJson.json).toMatchObject({ error: 'bad_request' })

    const badRooms = await call(base, TOKEN, '/listen', { method: 'POST', body: { rooms: 'not-a-list' } })
    expect(badRooms.status).toBe(400)
    expect(badRooms.json).toMatchObject({ error: 'bad_request' })
  })

  it('never prints the bearer token, only `token=set`', () => {
    const output = stderrOf()
    expect(output).not.toContain(TOKEN)
    expect(output).toContain('token=set')
  })
})

// ===========================================================================
// ilink backend (sidecar/weixin-ilink-bridge, Node run + mock iLink server)
// ===========================================================================

const ILINK_SERVER = resolve(REPO, 'sidecar', 'weixin-ilink-bridge', 'server.mjs')
const ILINK_READY = existsSync(ILINK_SERVER)

const ILINK_BOT_ID = 'mockbot@im.bot'
const ILINK_USER_ID = 'tester@im.wechat'
const ILINK_CTX = 'ctx-token-A'

interface MockIlink { url: string; captured: { sendmessage: any[]; getupdates: number }; close: () => Promise<void> }

/** A mock iLink server + CDN matching the protocol the vendored client speaks (getUpdates / sendmessage / download). */
async function startMockIlink(): Promise<{ mock: MockIlink; plaintext: Buffer; cipher: Buffer }> {
  const aesKeyHex = '00112233445566778899aabbccddeeff'
  const plaintext = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('mock-image-body', 'utf8')])
  const cipher = (() => {
    const c = createCipheriv('aes-128-ecb', Buffer.from(aesKeyHex, 'hex'), null)
    return Buffer.concat([c.update(plaintext), c.final()])
  })()
  const aesKeyB64 = Buffer.from(aesKeyHex, 'utf8').toString('base64') // official encoding: base64(utf8(hex))
  let cdnPort = 0
  const mediaRef = () => ({
    encrypt_query_param: 'mock-download-param',
    full_url: `http://127.0.0.1:${cdnPort}/mock/cdn/download`,
    aes_key: aesKeyB64, encrypt_type: 1,
  })
  const builtMessages = () => [
    { message_id: 1001, from_user_id: ILINK_USER_ID, to_user_id: ILINK_BOT_ID, message_type: 1, context_token: ILINK_CTX, item_list: [{ type: 1, text_item: { text: '你好，这是第一条消息' } }] },
    { message_id: 1002, from_user_id: ILINK_USER_ID, to_user_id: ILINK_BOT_ID, message_type: 1, context_token: ILINK_CTX, item_list: [{ type: 2, image_item: { media: mediaRef(), mid_size: cipher.length } }] },
    { message_id: 1003, from_user_id: ILINK_USER_ID, to_user_id: ILINK_BOT_ID, message_type: 1, context_token: ILINK_CTX, item_list: [{ type: 4, file_item: { media: mediaRef(), file_name: 'report.txt', len: String(plaintext.length) } }] },
    { message_id: 1004, from_user_id: ILINK_USER_ID, to_user_id: ILINK_BOT_ID, message_type: 1, context_token: ILINK_CTX, item_list: [{ type: 3, voice_item: { media: mediaRef() } }] },
  ]
  const captured: MockIlink['captured'] = { sendmessage: [], getupdates: 0 }
  const server: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`
    const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (route === 'POST /ilink/bot/getupdates') {
      captured.getupdates += 1
      const first = captured.getupdates === 1
      return json(200, first
        ? { ret: 0, msgs: builtMessages(), get_updates_buf: 'buf-1', longpolling_timeout_ms: 35_000 }
        : { ret: 0, msgs: [], get_updates_buf: 'buf-1', longpolling_timeout_ms: 35_000 })
    }
    if (route === 'POST /ilink/bot/sendmessage') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const msg = parsed.msg ?? {}
        captured.sendmessage.push({ to: msg.to_user_id, context_token: msg.context_token, items: (msg.item_list ?? []).map((item: any) => ({ type: item.type, text: item.text_item?.text })) })
        json(200, { ret: 0 })
      })
      return
    }
    if (route === 'POST /ilink/bot/msg/notifystart' || route === 'POST /ilink/bot/msg/notifystop') return json(200, { ret: 0 })
    if (route === 'GET /mock/cdn/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(cipher.length) })
      return res.end(cipher)
    }
    return json(404, { ret: -1, errmsg: 'mock: unknown route' })
  })
  const port = await new Promise<number>(resolve_ => server.listen(0, '127.0.0.1', () => { cdnPort = (server.address() as { port: number }).port; resolve_(cdnPort) }))
  return {
    mock: { url: `http://127.0.0.1:${port}`, captured, close: () => new Promise<void>(resolve_ => server.close(() => resolve_())) },
    plaintext, cipher,
  }
}

describe.skipIf(!ILINK_READY)('weixin-ilink-bridge (ilink) HTTP contract — mock iLink server', () => {
  const HTTP_TOKEN = `ilink-contract-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  let child: ChildProcess | undefined
  let stderrOf = () => ''
  let mock: MockIlink | undefined
  let plaintext: Buffer = Buffer.alloc(0)
  let dir = ''
  let port = 0
  let base = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ilink-contract-'))
    const started = await startMockIlink()
    mock = started.mock
    plaintext = started.plaintext
    const authFile = join(dir, 'auth.json')
    writeFileSync(authFile, JSON.stringify({ token: 'mock-bot-token', baseUrl: mock.url, botId: ILINK_BOT_ID, userId: ILINK_USER_ID, channelVersion: '2.4.6' }))
    chmodSync(authFile, 0o600)

    let lastError: unknown
    for (let attempt = 0; attempt < 5 && !base; attempt += 1) {
      port = pickPort()
      const spawned = spawnSidecar(NODE, [ILINK_SERVER, 'run', '--port', String(port), '--token', HTTP_TOKEN,
        '--auth-file', authFile, '--sync-buf-file', join(dir, 'syncbuf.txt'), '--poll-idle-ms', '50'])
      child = spawned.child
      stderrOf = spawned.stderr
      try {
        // Ready once the background poll has ingested the mock's first getUpdates batch.
        await waitUntil(async () => (await call(`http://127.0.0.1:${port}`, HTTP_TOKEN, '/messages?room=&limit=50')).json?.events?.length >= 4, 12_000, 'ilink bridge')
        base = `http://127.0.0.1:${port}`
      } catch (error) {
        lastError = error
        await stopSidecar(child)
        child = undefined
      }
    }
    if (!base) {
      await mock.close()
      mock = undefined
      throw lastError ?? new Error('the ilink bridge did not start')
    }
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await stopSidecar(child)
    if (port) expect(await isPortOpen(port), `the ilink bridge still listens on 127.0.0.1:${port}`).toBe(false)
    if (mock) await mock.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TEST_TIMEOUT_MS)

  it('serves /health and /status with the ilink capability report (mentions none, members observed)', async () => {
    const health = await call(base, HTTP_TOKEN, '/health')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({ ok: true, available: true, backend: 'ilink', sidecar: '1' })
    expect(health.json.capabilities).toMatchObject({ mentions: 'none', members: 'observed', media: true })

    const status = await call(base, HTTP_TOKEN, '/status')
    expect(status.status).toBe(200)
    expect(status.json).toMatchObject({ loggedIn: true, wxid: ILINK_BOT_ID, backend: 'ilink', client: 'ilink' })
  })

  it('lists the observed single-chat peer and its members', async () => {
    const rooms = await call(base, HTTP_TOKEN, '/rooms')
    expect(rooms.status).toBe(200)
    const peers = rooms.json.rooms as any[]
    expect(peers.length).toBe(1)
    expect(peers[0].id).toMatch(/^ilink_[0-9a-f]{16}$/)
    expect(typeof peers[0].name).toBe('string')

    const members = await call(base, HTTP_TOKEN, `/members?room=${encodeURIComponent(peers[0].id)}`)
    expect(members.status).toBe(200)
    expect((members.json.members as any[]).map(member => member.id)).toEqual([peers[0].id])
    expect((await call(base, HTTP_TOKEN, '/members?room=unknown')).json.members).toEqual([])
  })

  it('serves /messages with the §3 field shape, single-chat room "", and cursor paging', async () => {
    const page = await call(base, HTTP_TOKEN, '/messages?room=&limit=50')
    expect(page.status).toBe(200)
    const events = page.json.events as any[]
    expect(events.length).toBe(4)
    expect(typeof page.json.next).toBe('string')
    expect(typeof page.json.head).toBe('string')

    const [first, image, file, voice] = events
    expect(first).toMatchObject({ nativeId: '1001', room: '', text: '你好，这是第一条消息', ats: [], own: false })
    expect(first.sender.id).toMatch(/^ilink_[0-9a-f]{16}$/)
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(image).toMatchObject({ text: '[图片]' })
    expect(image.media).toEqual([{ id: '1002#0', kind: 'image' }])
    expect(file.text).toBe('[文件消息]')
    expect(voice.text).toBe('[语音消息]')
    for (const event of events) {
      expect(event).toHaveProperty('quoteId')
      expect(typeof event.own).toBe('boolean')
      expect(typeof event.text).toBe('string')
      expect(event.text.length).toBeGreaterThan(0)
    }

    // Cursor semantics (§4): reading on from `next` yields no new events and keeps `next` unchanged.
    const tail = await call(base, HTTP_TOKEN, `/messages?room=&cursor=${encodeURIComponent(page.json.next)}`)
    expect(tail.status).toBe(200)
    expect(tail.json.events).toEqual([])
    expect(tail.json.next).toBe(page.json.next)
  })

  it('downloads an image over the mock CDN (AES-decrypted), 501s an unsupported voice, 404s an unknown id', async () => {
    const image = await call(base, HTTP_TOKEN, '/media/1002%230')
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type') ?? '').toMatch(/^image\//)
    expect(image.bytes.equals(plaintext)).toBe(true)

    const file = await call(base, HTTP_TOKEN, '/media/1003%230')
    expect(file.status).toBe(200)
    expect(file.bytes.equals(plaintext)).toBe(true)

    const voice = await call(base, HTTP_TOKEN, '/media/1004%230')
    expect(voice.status).toBe(501)
    expect(voice.json).toMatchObject({ error: 'unsupported' })

    const unknown = await call(base, HTTP_TOKEN, '/media/nope%230')
    expect(unknown.status).toBe(404)
    expect(unknown.json).toMatchObject({ error: 'not_found' })
  })

  it('sends through the mock iLink with context_token, and de-dupes a replayed Idempotency-Key', async () => {
    const rooms = await call(base, HTTP_TOKEN, '/rooms')
    const peerId = (rooms.json.rooms as any[])[0].id
    const before = mock!.captured.sendmessage.length
    const send = await call(base, HTTP_TOKEN, '/send', { method: 'POST', body: { room: peerId, text: '回复测试' } })
    expect(send.status).toBe(200)
    expect(typeof send.json.msgId).toBe('string')
    expect(send.json.deduped).toBe(false)
    const sent = mock!.captured.sendmessage[before]
    expect(sent.to).toBe(ILINK_USER_ID)
    // The contract requires the outbound to carry back the peer's context_token.
    expect(sent.context_token).toBe(ILINK_CTX)
    expect(sent.items[0]).toEqual({ type: 1, text: '回复测试' })

    const a = await call(base, HTTP_TOKEN, '/send', { method: 'POST', headers: { 'Idempotency-Key': 'idem-1' }, body: { room: peerId, text: '幂等A' } })
    const b = await call(base, HTTP_TOKEN, '/send', { method: 'POST', headers: { 'Idempotency-Key': 'idem-1' }, body: { room: peerId, text: '幂等A' } })
    expect(b.json.deduped).toBe(true)
    expect(b.json.msgId).toBe(a.json.msgId)
  })

  it('records the listen set, and enforces auth/routing/method semantics', async () => {
    const rooms = await call(base, HTTP_TOKEN, '/rooms')
    const peerId = (rooms.json.rooms as any[])[0].id
    const listen = await call(base, HTTP_TOKEN, '/listen', { method: 'POST', body: { rooms: [peerId] } })
    expect(listen.status).toBe(200)
    expect((listen.json.listening as any[]).some(room => room.id === peerId)).toBe(true)
    const cleared = await call(base, HTTP_TOKEN, '/listen', { method: 'POST', body: { rooms: [] } })
    expect((cleared.json.removed as string[])).toContain(peerId)

    expect((await call(base, null, '/health')).status).toBe(401)
    expect((await call(base, 'wrong-token', '/health')).status).toBe(401)
    expect((await call(base, HTTP_TOKEN, '/nope')).status).toBe(404)
    const wrongMethod = await call(base, HTTP_TOKEN, '/health', { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow') ?? '').toContain('GET')
    const badBody = await call(base, HTTP_TOKEN, '/listen', { method: 'POST', body: { rooms: 'nope' } })
    expect(badBody.status).toBe(400)
    expect(badBody.json).toMatchObject({ error: 'bad_request' })
  })

  it('never prints the HTTP bearer token', () => {
    expect(stderrOf()).not.toContain(HTTP_TOKEN)
  })
})

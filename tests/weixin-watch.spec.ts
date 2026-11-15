/** weixin-watch: the listen set it pushes to the backend each round, and what it reports back about it. */
import { describe, expect, it } from 'vitest'
import type { BridgeClient, BridgeInboundOptions, BridgeListenResult } from '../src/sources/chat/weixin/bridge.ts'
import { pollChat, pollRound, reconcileListen } from '../src/sources/weixin-watch.ts'
import { WeixinConfigSchema } from '../src/sources/chat/weixin/kind.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** A bridge stub that records every `/listen` call, so a test can prove the call was made or skipped. */
function stub(result: BridgeListenResult = { listening: [], added: [], removed: [], failed: [] }, calls: string[][] = [],
  options: (BridgeInboundOptions | undefined)[] = []): BridgeClient {
  return {
    async health() { return { ok: true, available: true } },
    async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
    async rooms() { return [] },
    async members() { return [] },
    async messages() { return { events: [], next: '' } },
    async send() { return { msgId: 'srv-1', deduped: false } },
    async listen(rooms, inbound) { calls.push([...rooms]); options.push(inbound); return result },
  }
}

const rooms = [{ id: 'wxname_aa', name: '研发-交付群' }, { id: 'wxname_bb', name: '运维群' }]

describe('reconcileListen', () => {
  it('sends the configured ids and reports what the backend confirmed it watches', async () => {
    const calls: string[][] = []
    const bridge = stub({ listening: rooms, added: ['研发-交付群'], removed: [], failed: [] }, calls)
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 2, unresolved: [] })
    // The id is what the configuration holds; the sidecar is what resolves it to a display name.
    expect(calls).toEqual([['wxname_aa', 'wxname_bb']])
  })

  it('carries the inbound switches with the chat set, so a changed switch reaches the sidecar', async () => {
    const calls: string[][] = []
    const options: (BridgeInboundOptions | undefined)[] = []
    await reconcileListen(stub(undefined, calls, options), rooms, { voice: false, images: true })
    expect(calls).toEqual([['wxname_aa', 'wxname_bb']])
    expect(options).toEqual([{ voice: false, images: true }])
  })

  it('sends no options for a caller that names none, which the backend reads as its defaults', async () => {
    const options: (BridgeInboundOptions | undefined)[] = []
    await reconcileListen(stub(undefined, [], options), rooms)
    expect(options).toEqual([undefined])
  })

  it('names the chats the backend could not resolve, instead of counting them as watched', async () => {
    const bridge = stub({ listening: [rooms[0]!], added: [], removed: [], failed: [{ room: 'wxname_bb', detail: 'no such chat' }] })
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 1, unresolved: ['wxname_bb'] })
  })

  it('does nothing when no chat is configured, so a sidecar someone configured on its own is left alone', async () => {
    const calls: string[][] = []
    await expect(reconcileListen(stub(undefined, calls), [])).resolves.toEqual({ watching: 0, unresolved: [] })
    expect(calls).toEqual([])
  })

  it('does nothing for a backend that cannot change its listen set at runtime', async () => {
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events: [], next: '' } },
      async send() { return { msgId: 'srv-1', deduped: false } },
    }
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 0, unresolved: [] })
  })
})

describe('pollChat Feishu-aligned behavior', () => {
  const event = (nativeId: string, text: string, extra: Record<string, unknown> = {}) => ({
    nativeId, chatId: 'wxname_group', sender: { id: 'wxname_person', name: '阿黎' }, text, at: '2026-11-08T00:00:00Z',
    ats: [], ownMessage: false, mentionsAgent: false, ...extra,
  })

  function harness(events: unknown[], initialCursor: string | undefined = '0') {
    let cursor = initialCursor
    const sent: unknown[] = []
    const received: unknown[] = []
    const bridge = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events, next: '9', head: '9' } },
      async send(message: unknown) { sent.push(message); return { msgId: 'srv-1', deduped: false } },
    } as unknown as BridgeClient
    const ctx = {
      state: { get: () => cursor, set: (_key: unknown, value: string) => { cursor = value } },
      receive: async (trigger: unknown) => { received.push(trigger) },
    } as unknown as SourceContext
    return { bridge, ctx, sent, received, cursor: () => cursor }
  }

  it('does not send receipts, canned replies, or progress notes', async () => {
    const h = harness([event('m1', '请查订单 12345')])
    await expect(pollChat(h.ctx, h.bridge, 'weixin', 'wxname_group',
      { autoReplies: [{ any: '订单', reply: '已收到' }], acknowledge: true, ackText: '收到', progressAfterSeconds: 60 }))
      .resolves.toBe(1)
    expect(h.sent).toEqual([])
    expect(h.received).toHaveLength(1)
  })

  it('does not process the first page as new work', async () => {
    const h = harness([event('m2', '历史消息')], '')
    await expect(pollChat(h.ctx, h.bridge, 'weixin', 'wxname_group', {})).resolves.toBe(0)
    expect(h.received).toHaveLength(0)
    expect(h.cursor()).toBe('9')
  })

  it('skips the agent own message and leaves a backfilled message to the assessment', async () => {
    const own = harness([event('m3', '订单', { ownMessage: true })])
    await pollChat(own.ctx, own.bridge, 'weixin', 'wxname_group', {})
    expect(own.received).toHaveLength(0)
    expect(own.sent).toEqual([])

    const historical = harness([event('m4', 'order 999', { historical: true, mentionsAgent: true })])
    await expect(pollChat(historical.ctx, historical.bridge, 'weixin', 'wxname_group', {})).resolves.toBe(1)
    expect(historical.received).toHaveLength(1)
  })
})

describe('pollChat cursor', () => {
  function harness(head: string, events: unknown[]) {
    let cursor: string | undefined = '8'
    const received: unknown[] = []
    const bridge = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events, next: '9', head } },
      async send() { return { msgId: 'srv', deduped: false } },
    } as unknown as BridgeClient
    const ctx = {
      state: { get: () => cursor, set: (_key: unknown, value: string) => { cursor = value } },
      receive: async (t: unknown) => { received.push(t) },
    } as unknown as SourceContext
    return { bridge, ctx, received, cursor: () => cursor }
  }

  it('starts over when the backend sequence is behind the stored cursor, instead of going silent', async () => {
    // A restart used to begin the sidecar's sequence at zero while this cursor stayed stored, so every later event was
    // filtered out: the chat read as quiet forever, with nothing in any log. `head` is what makes that visible.
    const stale = harness('4', [{ nativeId: 'c-1', chatId: '', direct: true, sender: { id: 'wxname_p', name: '阿黎' },
      text: '网页游戏做好了吗？', at: '2026-11-08T10:05:00Z', ats: [], ownMessage: false, mentionsAgent: false }])
    await expect(pollChat(stale.ctx, stale.bridge, 'weixin', 'chat-x', {})).resolves.toBe(0)
    expect(stale.cursor()).toBe('')

    // One the cursor has caught up with, a page is read normally.
    const ahead = harness('9', [{ nativeId: 'c-1', chatId: '', direct: true, sender: { id: 'wxname_p', name: '阿黎' },
      text: '网页游戏做好了吗？', at: '2026-11-08T10:05:00Z', ats: [], ownMessage: false, mentionsAgent: false }])
    ;(ahead.ctx.state as unknown as { get: () => string }).get = () => '4'
    await expect(pollChat(ahead.ctx, ahead.bridge, 'weixin', 'chat-y', {})).resolves.toBe(1)
    expect(ahead.received).toHaveLength(1)
  })
})

describe('pollRound', () => {
  /** A context just wide enough for one round: stored cursors, the inbox, and a health sink. */
  function context(people: { id: string }[] = []) {
    const received: unknown[] = []
    const store = new Map<string, unknown>()
    store.set('chat-history:weixin:', '1')
    const ctx = {
      state: {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value) },
        keys: () => [...store.keys()],
      },
      allowed: () => people,
      receive: async (trigger: unknown) => { received.push(trigger); return 'stored' },
      report: () => {},
      configured: () => true,
      config: () => undefined,
    } as unknown as SourceContext
    return { ctx, received }
  }

  /** A bridge whose direct stream holds one message from a person, and no chats. */
  function directBridge() {
    const asked: string[] = []
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages(room) {
        asked.push(room)
        if (room !== '') return { events: [], next: '' }
        return { events: [{
          nativeId: 'dm-1', chatId: '', sender: { id: 'wxname_person', name: '<成员>' }, text: '请帮我看下',
          at: '2026-11-09T00:00:00Z', mentionsAgent: false, direct: true, ownMessage: false, quoteId: '',
          attachments: [], media: [],
        } as never], next: '1', head: '1' }
      },
      async send() { return { msgId: 'srv-1', deduped: false } },
    }
    return { bridge, asked }
  }

  const config = (directMessages: boolean) => WeixinConfigSchema.parse({
    tokenFile: 'C:/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [], directMessages,
  })

  it('reads the direct stream with no chat configured, so a person is listed once - in the Policy', async () => {
    const { ctx, received } = context()
    const { bridge, asked } = directBridge()
    const round = await pollRound(ctx, config(true), new AbortController().signal, bridge)
    // The shared stream is read by its empty room, once per round.
    expect(asked).toEqual([''])
    expect(round.received).toBe(1)
    expect(received).toHaveLength(1)
    expect((received[0] as { actor: { id: string } }).actor.id).toBe('wxname_person')
  })

  it('reads nothing when direct messages are switched off', async () => {
    const { ctx, received } = context()
    const { bridge, asked } = directBridge()
    await pollRound(ctx, config(false), new AbortController().signal, bridge)
    expect(asked).toEqual([])
    expect(received).toHaveLength(0)
  })

  it('watches the people the Policy lists, so their direct messages are delivered at all', async () => {
    // The sidecar only delivers what its listener was told to watch. With no group configured, the Policy's people are the
    // whole watch set - which is why naming a person once, in the Policy, is enough.
    const calls: string[][] = []
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events: [], next: '' } },
      async send() { return { msgId: 'srv-1', deduped: false } },
      async listen(rooms) { calls.push([...rooms]); return { listening: [], added: [...rooms], removed: [], failed: [] } },
    }
    const { ctx } = context([{ id: 'wxname_person' }])
    await pollRound(ctx, WeixinConfigSchema.parse({
      tokenFile: 'C:/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [], directMessages: true,
    }), new AbortController().signal, bridge)
    expect(calls).toEqual([['wxname_person']])
  })

  it('watches nothing when direct messages are off and no group is configured', async () => {
    const calls: string[][] = []
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events: [], next: '' } },
      async send() { return { msgId: 'srv-1', deduped: false } },
      async listen(rooms) { calls.push([...rooms]); return { listening: [], added: [...rooms], removed: [], failed: [] } },
    }
    const { ctx } = context([{ id: 'wxname_person' }])
    await pollRound(ctx, WeixinConfigSchema.parse({
      tokenFile: 'C:/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [], directMessages: false,
    }), new AbortController().signal, bridge)
    expect(calls).toEqual([])
  })
})

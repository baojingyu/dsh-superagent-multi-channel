/** Weixin source plugin entry: registers the kind and polls its sidecar bridge for new messages in the configured chats. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { createBridgeClient, type BridgeClient, type BridgeInboundOptions } from './chat/weixin/bridge.ts'
import { rememberWeixinStatus, SOURCE, weixinKind, type WeixinConfig } from './chat/weixin/kind.ts'
import type { ChatEvent } from './chat/port.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

export const kind = weixinKind
export const name = 'dsh-superagent-multi-channel-weixin'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(weixinKind), 'weixin: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, weixinKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report('weixin', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

/**
 * The Trigger of one bridge event: the platform message ID namespaced by the instance, on the Thread of its chat. Exported
 * for the tests: the image IDs of a message must survive into `meta.media`, which is what assessments read.
 */
export function triggerOf(event: ChatEvent, instance: string): Trigger {
  const thread = event.chatId || event.sender.id
  return {
    id: key(SOURCE, event.nativeId),
    source: instance,
    threads: [{ source: instance, id: thread }],
    actor: { source: instance, id: event.sender.id },
    human: !event.sender.bot,
    ...event.direct ? { addressed: 'direct' as const } : event.mentionsAgent ? { addressed: 'mention' as const } : {},
    at: event.at,
    text: event.text,
    ...event.url ? { url: event.url } : {},
    channel: { source: instance, thread: `${instance}:${thread}`,
      address: { room: event.chatId, wxid: event.sender.id, ...event.nativeId ? { quoteId: event.nativeId } : {} } },
    meta: { room: event.chatId, direct: event.direct, senderId: event.sender.id, ats: event.ats ?? [], nativeId: event.nativeId,
      ...event.media?.length ? { media: event.media.map(item => item.id) } : {},
      ...event.parentId ? { parentId: event.parentId } : {} },
  }
}

/**
 * Poll options are kept for config compatibility, but the WeChat watch loop deliberately does not send
 * automatic receipts, canned replies, or "still working" notes. The official Feishu source has no such
 * side channels: a message is handed to the Engine and only the Engine's normal reply/notice goes out.
 */
export interface PollOptions {
  autoReplies?: readonly { any: string; reply: string }[]
  acknowledge?: boolean
  ackText?: string
  progressAfterSeconds?: number
}

/** Reads one chat from its stored cursor and hands every message not the agent's own to the Engine. */
export async function pollChat(ctx: SourceContext, bridge: BridgeClient, instance: string, chat: string,
  options: PollOptions = {}): Promise<number> {
  void options
  const cursor = ctx.state.get(KV.chat.history(instance, chat))
  const page = await bridge.messages(chat, cursor)
  // Match Feishu's first poll: establish the current head as the baseline and do not replay the chat's
  // historical messages as fresh requests. A later poll reads only what arrived after this point.
  if (!cursor) {
    ctx.state.set(KV.chat.history(instance, chat), page.head || page.next || '0')
    return 0
  }
  // A sidecar restart used to begin its sequence at zero while this cursor is stored, so every later event was filtered
  // out and the chat went silent with no error anywhere. The page now carries the backend's head: a cursor ahead of it
  // means the counter moved backwards, and starting over is the only way to see the messages again. Repeats are absorbed
  // upstream, which keys a Trigger by its message id.
  if (page.head && cursor && Number(cursor) > Number(page.head)) {
    ctx.state.set(KV.chat.history(instance, chat), '')
    return 0
  }
  let received = 0
  for (const event of page.events) {
    // The bridge delivers the agent's own messages back as echoes; they never authorize work.
    if (event.ownMessage) continue
    // A message the bridge read back after a re-attach (or on first listen) is history, not a fresh request: it reaches the
    // assessment like Feishu's backfill, but never earns a receipt or a canned reply for something said before we listened.
    if (event.historical) {
      await ctx.receive(triggerOf(event, instance))
      received += 1
      continue
    }
    // Feishu parity: hand the message to the Engine and let its normal reply/notice decide what is sent.
    // No immediate receipt, no canned keyword reply, no progress note originates here.
    await ctx.receive(triggerOf(event, instance))
    received += 1
  }
  // The cursor advances only after the page is handed over, so a stopped poll reads the same page again.
  if (page.next !== cursor) ctx.state.set(KV.chat.history(instance, chat), page.next)
  return received
}

/**
 * Tells the backend which chats to watch, and reports what it confirmed plus what it could not resolve. The configuration
 * decides; the sidecar acts only on the difference, so this runs every round and adding or removing a chat in the panel
 * takes effect without restarting the sidecar. An empty configuration is skipped on purpose: it would silence a sidecar
 * whose chats someone configured on its own, while a Source with no chats already reads nothing. A backend that cannot
 * change its listen set at runtime answers `undefined` and is left alone.
 */
export async function reconcileListen(bridge: BridgeClient, rooms: readonly { id: string }[],
  options?: BridgeInboundOptions): Promise<{ watching: number; unresolved: string[] }> {
  if (rooms.length === 0 || !bridge.listen) return { watching: 0, unresolved: [] }
  const result = await bridge.listen(rooms.map(room => room.id), options)
  return { watching: result.listening.length, unresolved: result.failed.map(entry => entry.room) }
}

/** One polling round over the configured chats; the bridge's status is recorded for the kind's synchronous `facts`. */
export async function pollRound(ctx: SourceContext, config: WeixinConfig, signal: AbortSignal,
  supplied?: BridgeClient): Promise<PollRound> {
  const instance = SOURCE
  // The bridge is a parameter so a test can drive a round without a token file on disk.
  const bridge = supplied ?? createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, timeoutMs: config.timeoutSeconds * 1000 })
  // `/health` carries what the backend can actually do, and `scope` must answer synchronously, so it is read once per round
  // and remembered beside the status. It is a loopback call, and reading it every round is what lets a backend swap be
  // noticed without restarting this plugin.
  const health = await bridge.health()
  rememberWeixinStatus(await bridge.status(), health.capabilities)
  // The switches ride along with the chat set: the sidecar decides what to render as each message arrives, and a
  // changed switch has to reach it even when no chat changed.
  // The sidecar's queue is fed by its listener, and the listener only fires for watched chats. A person the Policy lists is
  // watched too, so naming them once - in the Policy - is enough for their direct messages to arrive at all.
  const people = config.directMessages ? ctx.allowed(SOURCE).map(entry => entry.id) : []
  const watch = [...new Set([...config.rooms.map(room => room.id), ...people])]
  const { watching, unresolved } = await reconcileListen(bridge, watch.map(id => ({ id })),
    { voice: config.voice, images: config.images })
  let received = 0
  // Direct messages are one stream keyed by sender, so a person needs no entry among the groups: polling `''` reads every
  // one of them, and the Policy decides who may originate work. Reading it only for listed people is what made the same
  // person need two entries.
  if (config.directMessages) {
    signal.throwIfAborted()
    received += await pollChat(ctx, bridge, instance, '', {
      autoReplies: config.autoReplies, acknowledge: config.acknowledge,
      ackText: config.ackText, progressAfterSeconds: config.progressAfterSeconds })
  }
  for (const room of config.rooms) {
    signal.throwIfAborted()
    received += await pollChat(ctx, bridge, instance, room.id, {
      autoReplies: config.autoReplies, acknowledge: config.acknowledge,
      ackText: config.ackText, progressAfterSeconds: config.progressAfterSeconds })
  }
  return { received, watching, unresolved }
}

/** What one round did: messages handed over, chats the backend confirmed it watches, and chats it could not resolve. */
interface PollRound { received: number; watching: number; unresolved: string[] }

/** Polls each chat every `pollSeconds`; setup and an off Source keep it quiet instead of failing. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('weixin', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(SOURCE)
    if (!config) ctx.report('weixin', health('paused', 'sourceOff'))
    else {
      try {
        const round = await pollRound(ctx, config, signal)
        if (!signal.aborted) {
          // The detail names the chats the backend confirmed it watches, so "configured but not watched" is visible in the
          // panel instead of looking like a quiet group. An unresolved chat is named rather than counted: it is the one
          // thing an operator has to fix.
          const watching = round.watching || config.rooms.length
          const unresolved = round.unresolved.length ? `; could not watch ${round.unresolved.join(', ')}` : ''
          ctx.report('weixin', { state: 'ready', detail: `${round.received} messages; watching ${watching}/${config.rooms.length}${unresolved}; next poll ≥ ${config.pollSeconds}s`,
            at: new Date().toISOString() })
        }
      } catch (error) { if (!signal.aborted) ctx.report('weixin', { state: 'error', detail: String(error) }) }
    }
    await pause((ctx.config<WeixinConfig>(SOURCE)?.pollSeconds ?? 5) * 1000, signal)
  }
}

/** Projex source plugin entry: registers the kind bound to the instance's adapter, and one work-item polling loop per enabled instance. */
import type { Context } from '@deepseek-ai/cordis'
import { health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { createProjexAdapter } from './work/projex/adapter.ts'
import { projexKind, type ProjexKindConfig } from './work/projex/kind.ts'
import { workKind } from './work/kind.ts'
import { pollWorkItems } from './work/stream.ts'
import type { SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export const kind = projexKind
export const name = 'dsh-superagent-multi-channel-projex'
export const inject = ['orchestrator']

/** Health entry this kind reports through; its instance prefix is added by the registry. */
const HEALTH_ENTRY = projexKind.health[0] ?? projexKind.kind

/** The kind whose comment channel posts through an adapter bound to `config`; without one, the kind's unbound adapter reports it. */
function kindFor(config: ProjexKindConfig | undefined): SourceKind<ProjexKindConfig> {
  if (!config?.organizationId) return projexKind
  try {
    const adapter = createProjexAdapter({ organization: config.organizationId, tokenFile: config.tokenFile, writeBack: config.writeBack })
    const bound = workKind<ProjexKindConfig>(adapter,
      { kind: projexKind.kind, host: projexKind.kind, title: projexKind.title, description: projexKind.description, provider: true })
    // Identity, schema, fields, scope, and environment stay the kind's; only the channel is bound to this instance's adapter.
    return { ...projexKind, channel: bound.channel }
  } catch {
    // A binding failure must not keep the plugin from loading; a send reports the unbound adapter instead.
    return projexKind
  }
}

/** The configuration of this kind's stored instance; the kind is not registered yet, so it is read as a stored entry. */
function configured(sources: SourceRegistry): ProjexKindConfig | undefined {
  try {
    return sources.instances().find(instance => instance.kind === projexKind.kind)?.config as ProjexKindConfig | undefined
  } catch {
    // A kind whose schema requires fields throws from `instances()` until defaults exist; that just means "not set up".
    return undefined
  }
}

/** Enabled Projex instances to poll; an unconfigured kind has none, and that must not fail the plugin. */
function instancesOf(ctx: Context): string[] {
  try {
    return ctx.orchestrator.sources.instances()
      .filter(instance => instance.kind === projexKind.kind && instance.enabled)
      .map(instance => instance.id)
  } catch {
    return []
  }
}

/** The Source context of one instance, so its health entries are keyed by the instance id. */
function contextOf(ctx: Context, instance: string): SourceContext {
  const kind = { kind: projexKind.kind, id: instance, health: projexKind.health }
  return ctx.orchestrator.context(kind as unknown as { kind: string; health: readonly string[] })
}

/** How a loop ended: it was aborted (so it may start again), or it cannot work in this process at all. */
type WatchOutcome = 'aborted' | 'fatal'

/**
 * Polls one instance: quiet while it is off or not configured, and any failure becomes that instance's error health.
 *
 * Returns `fatal` when the runtime itself never became ready. That promise settles once and stays rejected, so a loop that
 * ended there would fail identically on every retry; the supervisor keeps such an instance out of the rotation instead of
 * restarting it every reconcile tick, and reports the reason once.
 */
async function watch(source: SourceContext, instance: string, signal: AbortSignal): Promise<WatchOutcome> {
  try {
    await source.ready
  } catch (error) {
    if (!signal.aborted) source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    return 'fatal'
  }
  while (!signal.aborted) {
    const config = source.config<ProjexKindConfig>(instance)
    if (!config?.project) {
      if (!signal.aborted) source.report(HEALTH_ENTRY, health('paused', 'sourceOff'))
    } else {
      try {
        const adapter = createProjexAdapter({ organization: config.organizationId, tokenFile: config.tokenFile, writeBack: config.writeBack })
        const result = await pollWorkItems(source, adapter,
          { instance, project: config.project, categories: config.categories,
            // A first round of a real project reads from the epoch and archives every image, which is minutes of work. Reporting
            // the category it is on keeps the Source reading as busy instead of as a start that never finishes. The state stays
            // `ready`: `starting` is what the panel words as 启动中, so a per-category report in that state would make a Source
            // that is working flash "starting" for the whole round, which is the very symptom this reporting exists to remove.
            progress: event => {
              if (!signal.aborted) source.report(HEALTH_ENTRY, health('ready', 'polling',
                { category: event.category, index: String(event.index), total: String(event.total),
                  received: String(event.received) }))
            } }, signal)
        if (!signal.aborted) {
          source.report(HEALTH_ENTRY, result.errors.length
            ? { state: 'error', detail: result.errors.join('; ') }
            : { state: 'ready', detail: `${result.received} work items; next poll ≥ ${config.pollSeconds ?? 60}s`,
              at: new Date().toISOString() })
        }
      } catch (error) {
        if (!signal.aborted) source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
      }
    }
    await pause((source.config<ProjexKindConfig>(instance)?.pollSeconds ?? 60) * 1000, signal)
  }
  // Only an abort ends the loop, and that is not a failure: the supervisor may start the instance again.
  return 'aborted'
}

/** One running polling loop: the abort that stops it, and the loop's own end. */
interface Loop { stop: () => void; done: Promise<void> }
/**
 * How long the polling effect waits between two reads of the settings, for instances that were enabled, added or removed
 * while the plugin stayed loaded. It is not a poll interval: each loop keeps its own `pollSeconds`.
 */
const RECONCILE_MS = 5000

/**
 * Starts one loop per enabled instance and stops the loops whose instance went away, re-reading the settings on a timer
 * rather than once when the plugin loads.
 *
 * `Settings.save` restarts the plugin only when a save changes a field setup reads (`setupChanged`: the GitHub
 * repository and CLI, the Feishu bot CLI). A Source enabled, configured or added afterwards therefore keeps the plugin —
 * and this effect — loaded, so a set read only at load would leave that Source without a loop for the rest of the
 * plugin's life: its health entry would keep the `notReporting` placeholder `SourceRegistry.register` wrote when the kind
 * was registered, and the panel would show "启动中" with nothing to explain it, for as long as the plugin ran. Re-reading
 * the set costs one settings parse per interval, and a loop that is already running is left alone.
 *
 * A loop that ended `fatal` (the runtime never became ready) is not restarted: `source.ready` is settled for the life of
 * the process, so every retry would fail the same way and overwrite the health detail with the same message on every tick.
 * Such an instance is recorded in `dead` and left alone; it leaves that set when it is switched off and back on, so an
 * operator who fixed the runtime by editing settings does get a fresh attempt.
 */
export function supervise(ctx: Context, intervalMs = RECONCILE_MS): () => Promise<void> {
  const loops = new Map<string, Loop>()
  /** Instances whose loop cannot run in this process; cleared when the instance is disabled. */
  const dead = new Set<string>()
  const start = (instance: string): void => {
    const controller = new AbortController()
    const source = contextOf(ctx, instance)
    // A failure escaping the loop would terminate DSH, so it is reported as source health instead.
    const done = watch(source, instance, controller.signal)
      .catch((error: unknown): WatchOutcome => {
        source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
        return 'fatal'
      })
      .then((outcome: WatchOutcome) => {
        loops.delete(instance)
        if (outcome === 'fatal') dead.add(instance)
      })
    loops.set(instance, { stop: () => controller.abort(), done })
  }
  const reconcile = (): void => {
    const wanted = new Set(instancesOf(ctx))
    // An instance that is no longer wanted is stopped and forgotten, so re-enabling it starts a fresh loop.
    for (const instance of [...dead]) if (!wanted.has(instance)) dead.delete(instance)
    for (const [instance, loop] of loops) if (!wanted.has(instance)) { loop.stop(); loops.delete(instance) }
    for (const instance of wanted) if (!loops.has(instance) && !dead.has(instance)) start(instance)
  }
  reconcile()
  const timer = setInterval(reconcile, intervalMs)
  return async () => {
    clearInterval(timer)
    const running = [...loops.values()]
    loops.clear()
    for (const loop of running) loop.stop()
    await Promise.all(running.map(loop => loop.done))
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kindFor(configured(ctx.orchestrator.sources))), 'projex: source kind')
  ctx.effect(() => supervise(ctx), 'projex: work polling')
}
/**
 * The Projex polling effect: one loop per enabled instance, re-read from the settings instead of taken once at load, so a
 * Source enabled, configured or added while the plugin stays loaded still gets one.
 *
 * The regression this file holds: the effect used to map `sources.instances()` once, when the plugin loaded. `Settings.save`
 * restarts the plugin only when a field setup reads changed, so a Source switched on afterwards never got a loop: its
 * health entry kept the `starting` placeholder `SourceRegistry.register` wrote, and the panel showed "启动中" for as long
 * as the plugin ran. The fake instances keep `project` unset, so a loop reports `sourceOff` and never reaches the network.
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { health, type Health, type SourceContext } from '../src/sources/host.ts'
import { apply, supervise } from '../src/sources/projex-watch.ts'

/** One entry of `SourceRegistry.instances()`: the settings key, its kind, and whether the operator switched it on. */
interface Instance { id: string; kind: string; enabled: boolean; installed: boolean; config: Record<string, unknown> }
interface Watch { ctx: Context; instances: Instance[]; reports: { instance: string; entry: string; value: Health }[]
  registered: string[]; stop: () => Promise<void> }

/** An instance of this kind, off until the test switches it on, as the panel does. */
const instance = (over: Partial<Instance> = {}): Instance => ({ id: 'projex', kind: 'projex', enabled: false, installed: true, config: {}, ...over })

/** A cordis `Context` stand-in: the settings list the test changes under the plugin, and a `SourceContext` per instance. */
function fakeWatch(options: { ready?: Promise<void> } = {}): Watch {
  const instances: Instance[] = []
  const reports: Watch['reports'] = []
  const registered: string[] = []
  const disposers: (() => unknown)[] = []
  const context = (kind: { kind: string; id?: string }): SourceContext => {
    const id = kind.id ?? kind.kind
    return {
      ready: options.ready ?? Promise.resolve(),
      // As the real context: a disabled instance has no configuration to read.
      config: <C extends Record<string, unknown>>(instance: string) => instances.find(item => item.id === instance)?.enabled
        ? instances.find(item => item.id === instance)?.config as C : undefined,
      report: (entry: string, value: Health) => { reports.push({ instance: id, entry, value }) },
    } as unknown as SourceContext
  }
  const ctx = {
    effect: (run: () => unknown) => { const disposer = run(); if (typeof disposer === 'function') disposers.push(disposer as () => unknown) },
    orchestrator: {
      sources: { instances: () => instances, register: (kind: { kind: string }) => { registered.push(kind.kind); return () => {} } },
      context,
    },
  } as unknown as Context
  return { ctx, instances, reports, registered, stop: async () => { for (const disposer of disposers.reverse()) await disposer() } }
}

/** Drive the fake timers the polling loops and their waits use, without touching the clock the runtime reports. */
const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

it('registers the kind and starts no loop while no instance is enabled', async () => {
  const watch = fakeWatch()
  apply(watch.ctx)
  await advance(60_000)
  expect(watch.registered).toEqual(['projex'])
  expect(watch.reports).toEqual([])
  await watch.stop()
})

it('starts a loop for an instance enabled after the plugin loaded, and reports its health', async () => {
  const watch = fakeWatch()
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(1500)
  expect(watch.reports).toEqual([])
  watch.instances.push(instance({ enabled: true }))
  await advance(500)
  // An enabled instance without a project reports `sourceOff` and idles: it is on, and it has nothing to poll.
  expect(watch.reports).toEqual([{ instance: 'projex', entry: 'projex', value: health('paused', 'sourceOff') }])
  await watch.stop()
})

it('gives an instance added later its own loop, keyed by its own settings entry', async () => {
  const watch = fakeWatch()
  watch.instances.push(instance({ enabled: true }))
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(500)
  watch.instances.push(instance({ id: 'projex-ops', enabled: true }))
  await advance(500)
  expect(watch.reports.map(report => report.instance).sort()).toEqual(['projex', 'projex-ops'])
  await watch.stop()
})

it('leaves a running loop alone, so a reconcile never restarts the poll it is in the middle of', async () => {
  const watch = fakeWatch()
  watch.instances.push(instance({ enabled: true }))
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(2500)
  // Five reconciles, one loop: a restarted loop would have reported `sourceOff` once per reconcile.
  expect(watch.reports.length).toBe(1)
  await watch.stop()
})

it('stops the loop of an instance switched off again, and says nothing further for it', async () => {
  const watch = fakeWatch()
  const only = instance({ enabled: true })
  watch.instances.push(only)
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(500)
  expect(watch.reports.length).toBe(1)
  watch.instances.splice(0)
  await advance(120_000)
  expect(watch.reports.length).toBe(1)
  await watch.stop()
})

it('aborts every loop when the plugin unloads', async () => {
  const watch = fakeWatch()
  watch.instances.push(instance({ enabled: true }))
  apply(watch.ctx)
  await advance(5000)
  expect(watch.reports.length).toBe(1)
  await watch.stop()
  await advance(120_000)
  expect(watch.reports.length).toBe(1)
})

it('reports a runtime that never became ready once, and does not retry it on every reconcile', async () => {
  // `source.ready` is settled for the life of the process: retrying it every 5 s would only rewrite the same error and
  // restart a loop that cannot work.
  const watch = fakeWatch({ ready: Promise.reject(new Error('state directory locked')) })
  watch.instances.push(instance({ enabled: true }))
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(10)
  expect(watch.reports).toEqual([{ instance: 'projex', entry: 'projex', value: { state: 'error', detail: 'Error: state directory locked' } }])
  await advance(5000)
  expect(watch.reports).toHaveLength(1)
  await watch.stop()
})

it('gives a fatal instance a fresh loop once it is switched off and on again', async () => {
  // The operator's only in-process remedy is editing the settings, so that path has to clear the refusal.
  const watch = fakeWatch({ ready: Promise.reject(new Error('locked')) })
  const only = instance({ enabled: true })
  watch.instances.push(only)
  watch.ctx.effect(() => supervise(watch.ctx, 500))
  await advance(10)
  expect(watch.reports).toHaveLength(1)
  watch.instances.splice(0)
  await advance(500)
  watch.instances.push(only)
  await advance(500)
  expect(watch.reports).toHaveLength(2)
  await watch.stop()
})

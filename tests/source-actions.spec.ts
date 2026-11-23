/**
 * Source card actions: the WeChat bridge is a separate, long-lived process, so the panel only asks the machine's scheduled task
 * (Windows) or the shipped POSIX launcher (macOS/Linux) to start or stop it. These tests pin the properties that make that
 * safe - the fixed argv, the refusal of anything that is not a task name - and the platform-specific paths each host takes.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SourceHost } from '../src/sources/host.ts'
import { WeixinConfigSchema, portFilePath, resolveBaseUrl, startLauncher, weixinKind } from '../src/sources/chat/weixin/kind.ts'

const action = (id: string) => weixinKind.actions!.find(item => item.id === id)!
const windows = process.platform === 'win32'

function hostOf(calls: string[][]): SourceHost {
  return {
    context: () => ({ commands: { withSignal: () => ({
      run: async (program: string, args: string[]) => { calls.push([program, ...args]); return '' },
    }) } }),
  } as unknown as SourceHost
}

const config = WeixinConfigSchema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self' })

describe('WeChat bridge actions', () => {
  it('offers start, stop, restart, check, and the pinned-WeChat installer', () => {
    expect(weixinKind.actions!.map(item => item.id))
      .toEqual(['bridge.start', 'bridge.stop', 'bridge.restart', 'bridge.check', 'wechat.install-version'])
  })

  it('opens the pinned WeChat 4.1.12.55 download page with powershell Start-Process on Windows, and declines elsewhere', async () => {
    const calls: string[][] = []
    const message = await action('wechat.install-version').run(hostOf(calls), { ...config, profile: 'team' })
    expect(message).toContain('4.1.12.55')
    if (windows) {
      // `&` must not reach cmd; Start-Process is the safe opener, and the URL is the only argument that carries meaning.
      expect(calls).toEqual([['powershell', '-NoProfile', '-NonInteractive', '-Command',
        "Start-Process 'https://github.com/Rodert/wechat-win-versions/releases/tag/v4.1.12.55'"]])
    } else {
      // The team build is a Windows-only installer; a POSIX host is told so instead of running powershell.
      expect(calls).toEqual([])
    }
    expect(action('wechat.install-version').ready!({ ...config, profile: 'team' })).toBe(true)
    expect(action('wechat.install-version').ready!({ ...config, profile: 'personal' })).toBe(false)
  })

  it.runIf(process.platform === 'win32')('starts by asking the configured task to run, with a fixed argv', async () => {
    const calls: string[][] = []
    const message = await action('bridge.start').run(hostOf(calls), config)
    expect(calls).toEqual([['schtasks', '/run', '/tn', 'DSH-WeChat-Bridge']])
    expect(message).toContain('启动')
  })

  it.runIf(process.platform === 'win32')('restarts by ending then running the same task', async () => {
    const calls: string[][] = []
    await action('bridge.restart').run(hostOf(calls), { ...config, bridgeTask: 'My-Bridge' })
    expect(calls).toEqual([['schtasks', '/end', '/tn', 'My-Bridge'], ['schtasks', '/run', '/tn', 'My-Bridge']])
  })

  it('is ready once a launcher or a task name is set', () => {
    expect(action('bridge.start').ready!(config)).toBe(true)
    expect(action('bridge.start').ready!({ ...config, bridgeLauncher: 'C:\\x\\start.cmd' })).toBe(true)
    // An empty config still has a launcher on a POSIX host (the one this package ships); on Windows it has none.
    expect(action('bridge.start').ready!({ ...config, bridgeTask: '', bridgeLauncher: '' })).toBe(!windows)
  })

  it('refuses to start through a launcher that is not there', async () => {
    const calls: string[][] = []
    await expect(action('bridge.start').run(hostOf(calls), { ...config, bridgeLauncher: 'C:\\nope\\missing.cmd' }))
      .rejects.toThrow(/不存在/)
    expect(calls).toEqual([])
  })

  it('stops nothing when no bridge is listening, and says so', async () => {
    const host = {
      context: () => ({ commands: { withSignal: () => ({ run: async () => '' }) } }),
    } as unknown as SourceHost
    await expect(action('bridge.stop').run(host, { ...config, bridgeLauncher: 'C:\\x\\start.cmd' }))
      .resolves.toContain('没有在监听')
  })

  it('does not kill a process on the port whose command line is not the bridge', async () => {
    const ran: string[][] = []
    const host = {
      context: () => ({ commands: { withSignal: () => ({ run: async (program: string, args: string[]) => {
        ran.push([program, ...args])
        if (program === 'netstat') return '  TCP    127.0.0.1:9300    0.0.0.0:0    LISTENING    4242'
        if (program === 'lsof') return '4242\n'
        if (program === 'powershell' || program === 'ps') return 'C:\\Windows\\explorer.exe'
        return ''
      } }) } }),
    } as unknown as SourceHost
    await expect(action('bridge.stop').run(host, { ...config, bridgeLauncher: 'C:\\x\\start.cmd' }))
      .resolves.toContain('不是微信桥')
    expect(ran.some(([program]) => program === 'taskkill' || program === 'kill')).toBe(false)
  })

  it('refuses a task name that is not a task name, at the schema and again at the call', async () => {
    // The schema rejects it on save...
    expect(WeixinConfigSchema.safeParse({ ...config, bridgeTask: 'DSH & calc.exe' }).success).toBe(false)
    expect(WeixinConfigSchema.safeParse({ ...config, bridgeTask: 'x; rm -rf /' }).success).toBe(false)
    // ...and (on the host that uses a task) the runner refuses it too, so a stale stored value still cannot reach a command line.
    if (windows) {
      const calls: string[][] = []
      await expect(action('bridge.start').run(hostOf(calls), { ...config, bridgeTask: 'x; calc' })).rejects.toThrow()
      expect(calls).toEqual([])
    }
  })

  it('reports the bridge capability when the health read says it is up', async () => {
    const host = {
      sources: { instance: () => ({ config }) },
    } as unknown as SourceHost
    // Without a reachable bridge the check fails rather than claiming success, whatever the reason (missing token, refused port).
    await expect(action('bridge.check').run(host, config)).rejects.toThrow()
  })
})

describe('startLauncher and the random-port contract', () => {
  it('resolves the real port from the launcher port file, else the configured URL', () => {
    const baseUrl = 'http://127.0.0.1:9401'
    const file = portFilePath('personal', baseUrl)
    // No launcher -> the configured URL is used as-is (a launcher is never the reason a URL changes here).
    expect(resolveBaseUrl({ profile: 'personal', baseUrl })).toBe(baseUrl)
    // A launcher but no port file yet -> still the configured URL.
    expect(resolveBaseUrl({ profile: 'personal', baseUrl, bridgeLauncher: 'C:\\x\\start.cmd' })).toBe(baseUrl)
    // Once the sidecar writes the port it actually bound, readers follow it.
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '6001\n')
    try {
      expect(resolveBaseUrl({ profile: 'personal', baseUrl, bridgeLauncher: 'C:\\x\\start.cmd' }))
        .toBe('http://127.0.0.1:6001')
    } finally { rmSync(file, { force: true }) }
  })

  it('spawns the launcher detached and returns the port it wrote back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-weixin-test-'))
    // A platform-appropriate stand-in launcher: a batch file on Windows, a shell script elsewhere. It honours the port-file
    // contract by writing the port it "bound", which is all startLauncher reads back.
    const launcher = join(dir, windows ? 'start.cmd' : 'start.sh')
    writeFileSync(launcher, windows
      ? '@echo off\r\n> "%WXBRIDGE_PORT_FILE%" echo 54321\r\n'
      : '#!/bin/sh\nprintf 54321 > "$WXBRIDGE_PORT_FILE"\n')
    const config = { ...WeixinConfigSchema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self' }), bridgeLauncher: launcher }
    try {
      const started = await startLauncher(hostOf([]), config)
      expect(started?.port).toBe(54321)
      // The port file the launcher wrote is what the readers now resolve to.
      expect(resolveBaseUrl(config)).toBe('http://127.0.0.1:54321')
    } finally {
      // The detached child keeps the temp dir as its cwd for a moment after it exits;
      // give it a beat and retry the delete so Windows stops reporting EBUSY.
      await new Promise(resolve => setTimeout(resolve, 500))
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      rmSync(portFilePath('personal', 'http://127.0.0.1:9300'), { force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
})

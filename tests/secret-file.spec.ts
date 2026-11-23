/**
 * The shared secret-file reader: the owner-only rule on the platforms whose `st.mode` carries it, and the structural
 * checks that carry it on Windows, where Node synthesizes the mode and never reflects the ACL. The platform is stubbed
 * rather than the file's permissions, so the same assertion runs on every machine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSecretFile, requireOwnerOnly, resolveSecretPath } from '../src/infra/secret-file.ts'
import { withPlatform } from './fixtures/platform.ts'

/** The platform this worker started with, so a stub that leaks is caught instead of being reported as a later failure. */
const ORIGINAL = process.platform
/** How a reader names the file in its messages; the sentence around it is the shared helper's. */
const WHAT = 'The secret file'
let directory: string
let tokenFile: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'secret-file-'))
  tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'secret\n')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('requireOwnerOnly', () => {
  it('refuses any mode other than 0600 where the POSIX bits are real, naming the mode it found', async () => {
    await withPlatform('linux', () => {
      // The actual mode is the diagnosis: "not 644" says the file is group/world readable, "must be 0600" does not.
      expect(() => requireOwnerOnly(0o644, tokenFile, WHAT)).toThrow(/must have mode 0600, not 644/)
      expect(() => requireOwnerOnly(0o640, tokenFile, WHAT)).toThrow(/not 640/)
      expect(() => requireOwnerOnly(0o666, tokenFile, WHAT)).toThrow(/not 666/)
      // The message names the file, so a misconfigured deployment says which one to fix.
      expect(() => requireOwnerOnly(0o644, tokenFile, WHAT)).toThrow(tokenFile)
      expect(() => requireOwnerOnly(0o644, tokenFile, 'Yunxiao token file')).toThrow(/^Yunxiao token file must have mode 0600/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('accepts 0600 and ignores the file-type bits where the POSIX bits are real', async () => {
    await withPlatform('linux', () => {
      expect(() => requireOwnerOnly(0o600, tokenFile, WHAT)).not.toThrow()
      expect(() => requireOwnerOnly(0o100600, tokenFile, WHAT)).not.toThrow()
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('accepts the synthesized 0666 mode on Windows, where the bits carry no ACL information', async () => {
    await withPlatform('win32', () => {
      expect(() => requireOwnerOnly(0o666, tokenFile, WHAT)).not.toThrow()
      // A read-only file is synthesized as 0444; it is equally meaningless, and equally accepted.
      expect(() => requireOwnerOnly(0o444, tokenFile, WHAT)).not.toThrow()
    })
    expect(process.platform).toBe(ORIGINAL)
  })
})

describe('readSecretFile', () => {
  it('names the setting when no path is configured, instead of printing `undefined` as a path', () => {
    // "No path is configured" and "the file at this path is missing" are different faults. This one names the setting and
    // points at Start bridge, which writes its own file; the old code printed `undefined` as the file, which named nothing.
    expect(() => readSecretFile('', 'bridge token file')).toThrow(/No bridge token file path is configured/)
    expect(() => readSecretFile(undefined as unknown as string, 'bridge token file')).toThrow(/No bridge token file path is configured/)
  })

  it('reads and trims the file on Windows, where only the structural checks apply', async () => {
    await withPlatform('win32', () => {
      expect(readSecretFile(tokenFile, 'bridge token file')).toBe('secret')
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses a missing file on Windows, with the hint that says what to write there', async () => {
    const missing = join(directory, 'absent')
    await withPlatform('win32', () => {
      expect(() => readSecretFile(missing, 'bridge token file')).toThrow(/bridge token file .* is missing/)
      // A first-time operator only has this sentence: what the file holds and how it must be protected.
      expect(() => readSecretFile(missing, 'bridge token file')).toThrow(/write the token there and keep it owner-only \(0600/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses an empty file on Windows', async () => {
    const empty = join(directory, 'empty')
    writeFileSync(empty, '\n')
    await withPlatform('win32', () => {
      expect(() => readSecretFile(empty, 'bridge token file')).toThrow(/bridge token file .* is empty/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses a directory on Windows', async () => {
    const nested = join(directory, 'nested')
    mkdirSync(nested)
    await withPlatform('win32', () => {
      expect(() => readSecretFile(nested, 'bridge token file')).toThrow(/bridge token file .* is not a regular file/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('refuses the file the POSIX rule refuses, whichever platform the test runs on', async () => {
    // The file was created with the process's default mode, which is never 0600: 0666 on Windows, 0644 under a POSIX umask.
    await withPlatform('linux', () => {
      expect(() => readSecretFile(tokenFile, 'hosting token file')).toThrow(/The hosting token file must have mode 0600, not \d{3}/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })
})

describe('resolveSecretPath', () => {
  /** Run `body` with the home directory this machine reports pointed at `home`, which is what `~` expands to. */
  const withHome = (home: string, body: () => void): void => {
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    try { body() } finally {
      if (before.HOME === undefined) delete process.env.HOME; else process.env.HOME = before.HOME
      if (before.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = before.USERPROFILE
    }
  }
  it('expands a leading ~ to this account\'s home directory, which is how a settings field writes a path', () => {
    expect(resolveSecretPath('~/.projex-token.txt')).toBe(join(homedir(), '.projex-token.txt'))
    expect(resolveSecretPath('~')).toBe(homedir())
    expect(isAbsolute(resolveSecretPath('~/.projex-token.txt'))).toBe(true)
  })
  it('leaves an absolute path exactly as the operator wrote it', () => {
    expect(resolveSecretPath('/srv/secrets/token')).toBe('/srv/secrets/token')
  })
  it('refuses a relative path, because it would be read from the host process\'s working directory', () => {
    // The path that caused this rule: a literal `~` directory was created inside the profile directory the host started in.
    expect(() => resolveSecretPath('token')).toThrow(/must be an absolute path or start with ~\//)
    expect(() => resolveSecretPath('./secrets/token')).toThrow(/read from the host process's working directory/)
  })
  it('reads and names the file a ~ path resolves to, so writer and reader agree on one file', () => {
    const home = join(directory, 'home')
    mkdirSync(home)
    writeFileSync(join(home, 'token'), 'secret\n', { mode: 0o600 })
    withHome(home, () => {
      expect(resolveSecretPath('~/token')).toBe(join(home, 'token'))
      // The file is owner-only, so the same read succeeds on every platform.
      expect(readSecretFile('~/token', 'bridge token file')).toBe('secret')
      // A message names the resolved file, which is the one to create when the configured name is not there.
      expect(() => readSecretFile('~/absent', 'bridge token file')).toThrow(join(home, 'absent'))
    })
  })
})

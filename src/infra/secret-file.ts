/**
 * The owner-only check every secret-file reader shares, and the Windows exception that check needs.
 *
 * Node synthesizes `st.mode` on Windows (`0o666` for any writable file, `0o444` for a read-only one) and never reflects
 * the ACL, so a POSIX bit test there would refuse every real credential file. On Windows the bit test is therefore
 * skipped and the structural checks (exists, a regular file, not empty) carry the reader; owner-only is guaranteed by the
 * ACL there, and the operator's hardening step is `icacls <file> /inheritance:r /grant:r "%USERNAME%:R"`.
 */
import { readFileSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** A permission mode as the three octal digits a POSIX operator reads: `666`, not `438`. */
const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, '0')

/**
 * ACL answers already read, keyed by path + inode + ctime + size. Bounded because a long-lived host reads a handful of secret
 * files; the cap only stops a test suite that makes a new temp file per case from growing it without limit.
 */
const aclCache = new Map<string, string>()
const ACL_CACHE_MAX = 64

/**
 * The access control entries a macOS file carries besides its POSIX bits, as `ls -le` prints them, or `''` when there are none.
 *
 * `chmod 600` on macOS sets the mode and leaves extended ACLs alone, so a file can read `-rw-------` and still grant another
 * account - or `everyone` - read access; `st.mode` cannot see that, which makes the bit test necessary but not sufficient.
 * Only macOS has this layer: Linux reports no entry in this form, and Windows is skipped before this is reached. A failed read
 * of the ACL refuses the file, because an unproven guarantee is what the check exists to avoid.
 */
function aclGrants(file: string, info: Stats): string {
  if (process.platform !== 'darwin') return ''
  const stamp = `${file}\u0000${info.ino}\u0000${info.ctimeMs}\u0000${info.size}`
  const hit = aclCache.get(stamp)
  if (hit !== undefined) return hit
  let listing: string
  try {
    listing = execFileSync('ls', ['-led', file], { encoding: 'utf8', timeout: 5000 })
  } catch { return 'the ACL could not be read' }
  const extra = listing.split('\n').slice(1).map(line => line.trim()).filter(line => /^\d+:\s/.test(line)).join('; ')
  if (aclCache.size >= ACL_CACHE_MAX) aclCache.clear()
  aclCache.set(stamp, extra)
  return extra
}

/**
 * Resolves the path of a secret file the way the operator wrote it in a settings field, or refuses it.
 *
 * A leading `~` is this account's home directory, which is how a person writes `~/.projex-token.txt`. Anything else must
 * be absolute: a relative path is resolved against the host process's working directory — the DSH profile directory, an
 * IDE, a shell — so the file read is not the file the operator named, and a write lands somewhere they will never look.
 * That is not hypothetical: a Yunxiao token field holding `~/.projex-token.txt` became a directory named `~` inside the
 * profile directory the host was started from, so the sign-in wrote a token the operator never found, while the file they
 * created at `~/.projex-token.txt` stayed empty. Writers and readers share this one resolution, so both name one file.
 */
export function resolveSecretPath(file: string): string {
  const named = file.trim()
  const resolved = named === '~' ? homedir() : named.startsWith('~/') ? join(homedir(), named.slice(2)) : named
  if (!isAbsolute(resolved)) {
    throw new Error(`The secret file ${file} must be an absolute path or start with ~/, because a relative path is read from the host process's working directory rather than the operator's intent`)
  }
  return resolved
}

/**
 * Rejects a secret file that other accounts can read, on the platforms where `st.mode` means something.
 *
 * `what` names the file as its reader writes it ("Yunxiao token file"), so every caller keeps the wording its tests and
 * operators match on. The message always carries the mode that was found, because "not 666" tells an operator that the
 * file was made world-writable, while the required mode alone says nothing about the state it is in. On Windows nothing
 * is rejected here: there is no mode to report, and owner-only is the ACL's job (`icacls`, above).
 */
export function requireOwnerOnly(mode: number, file: string, what: string): void {
  if (process.platform === 'win32') return
  if ((mode & 0o777) !== 0o600) throw new Error(`${what} must have mode 0600, not ${octal(mode)}: ${file}`)
  // 0600 bits are necessary but not sufficient on macOS, where an extended ACL can still grant another account read access.
  const extra = aclGrants(file, statSync(file))
  if (extra !== '') throw new Error(`${what} carries an access control entry beyond its owner, so the 0600 bits alone do not keep it private (${extra}): ${file} - remove it with chmod -N ${file}`)
}

/**
 * Reads a secret file whose contents must be readable only by this account.
 *
 * `what` names the file in the messages ("bridge token file"), so each caller keeps its own wording. The file must
 * exist, be a regular file, pass `requireOwnerOnly`, and hold something: an empty secret file is a configuration error,
 * never an empty credential. The missing-file message carries the setup hint, which is the only pointer a first-time
 * operator gets when a credential file has not been written yet. A caller that falls back to an inline value when the
 * file is absent stats the path itself and calls `requireOwnerOnly` on the result. The message names the resolved path,
 * which is the file to create when the configured one is refused as relative.
 */
export function readSecretFile(file: string, what: string): string {
  // "No path is configured" is a different fact from "the file at this path is missing": the first names the setting and
  // points at the action that writes its own file, the second names the resolved file to create. Printing `undefined` as a
  // path named neither, so a configuration fault read as a file nobody could find.
  if (typeof file !== 'string' || file.trim() === '') throw new Error(`No ${what} path is configured, so there is no file to read: set the path in this Source's settings, or start the bridge, which writes its own token file and keeps it owner-only (0600, or an ACL on Windows)`)
  const path = resolveSecretPath(file)
  let info: Stats
  try { info = statSync(path) } catch {
    throw new Error(`The ${what} ${path} is missing; write the token there and keep it owner-only (0600, or an ACL on Windows)`)
  }
  if (!info.isFile()) throw new Error(`The ${what} ${path} is not a regular file`)
  requireOwnerOnly(info.mode, path, `The ${what}`)
  const value = readFileSync(path, 'utf8').trim()
  if (!value) throw new Error(`The ${what} ${path} is empty`)
  return value
}

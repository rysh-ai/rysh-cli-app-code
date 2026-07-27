import { execFile } from 'child_process'
import { promises as fsp, readlinkSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir } from 'os'

/**
 * Shell tab-completion support for the desktop app, mirroring the rysh-cli TUI
 * feature (fac677b). The renderer asks for completions of the token under the
 * cursor; this runs in the MAIN process so it can read $PATH, the filesystem,
 * and resolve the shell's live working directory from its pid (PaneSnapshot
 * ShellPID) via lsof (darwin) / /proc (linux).
 */

const BUILTINS = [
  'cd', 'echo', 'export', 'alias', 'unalias', 'set', 'unset', 'source', 'exit',
  'pwd', 'jobs', 'fg', 'bg', 'kill', 'history', 'type', 'which', 'read', 'eval',
  'exec', 'trap', 'wait', 'printf', 'let', 'local', 'return', 'shift', 'help',
  'test', 'true', 'false', 'umask', 'pushd', 'popd', 'dirs',
]

export interface CompletionCandidate {
  value: string // full replacement token, e.g. "src/model.go"
  isDir: boolean
}

function execFileP(cmd: string, args: string[], timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

async function resolveCwd(shellPid: number, reportedCwd?: string): Promise<string> {
  // OSC 7-reported cwd (PaneSnapshot.shell_cwd) is push-based and exact —
  // prefer it over pid-based resolution (which polls lsof/proc).
  if (reportedCwd && reportedCwd.trim() !== '') return reportedCwd
  if (shellPid && shellPid > 0) {
    try {
      if (process.platform === 'linux') return readlinkSync(`/proc/${shellPid}/cwd`)
      if (process.platform === 'darwin') {
        // lsof -a -p <pid> -d cwd -Fn → emits a line "n<path>" for the cwd fd.
        const out = await execFileP('lsof', ['-a', '-p', String(shellPid), '-d', 'cwd', '-Fn'])
        for (const line of out.split('\n')) {
          if (line.startsWith('n')) return line.slice(1)
        }
      }
    } catch {
      /* fall through to home */
    }
  }
  return homedir()
}

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

async function completeCommand(token: string): Promise<CompletionCandidate[]> {
  const set = new Set<string>()
  for (const b of BUILTINS) if (b.startsWith(token)) set.add(b)
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
  await Promise.all(
    dirs.map(async (d) => {
      let entries: string[] = []
      try {
        entries = await fsp.readdir(d)
      } catch {
        return
      }
      for (const name of entries) if (name.startsWith(token)) set.add(name)
    })
  )
  return Array.from(set)
    .sort()
    .slice(0, 300)
    .map((value) => ({ value, isDir: false }))
}

async function completePath(token: string, cwd: string): Promise<CompletionCandidate[]> {
  const slash = token.lastIndexOf('/')
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : '' // e.g. "src/"
  const prefix = slash >= 0 ? token.slice(slash + 1) : token
  let base = expandTilde(dirPart || '.')
  if (!isAbsolute(base)) base = join(cwd, base)
  let entries: string[] = []
  try {
    entries = await fsp.readdir(base)
  } catch {
    return []
  }
  const out: CompletionCandidate[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    if (prefix === '' && name.startsWith('.')) continue // hide dotfiles unless explicitly typed
    let isDir = false
    try {
      isDir = (await fsp.stat(join(base, name))).isDirectory()
    } catch {
      /* ignore unreadable entries */
    }
    out.push({ value: dirPart + name, isDir })
  }
  out.sort((a, b) => a.value.localeCompare(b.value))
  return out.slice(0, 300)
}

// ---------------------------------------------------------------------------
// bash programmable completion (mirrors rysh-cli internal/tui/completion_bash.go)
// ---------------------------------------------------------------------------

// bashCompletionDriver runs a command's programmable completion spec the way
// bash itself would: reconstruct COMP_WORDS/COMP_CWORD from the line, load
// the spec (on demand via _completion_loader), call its -F function, and
// print COMPREPLY one entry per line. $1 is the input line up to the cursor.
const BASH_COMPLETION_DRIVER = `
for f in /usr/share/bash-completion/bash_completion \\
         /opt/homebrew/etc/profile.d/bash_completion.sh \\
         /usr/local/etc/profile.d/bash_completion.sh \\
         /etc/bash_completion; do
  if [ -r "$f" ]; then . "$f" 2>/dev/null && break; fi
done
COMP_LINE="$1"
COMP_POINT=\${#COMP_LINE}
eval set -- "$COMP_LINE" 2>/dev/null || exit 0
COMP_WORDS=("$@")
COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 ))
case "$COMP_LINE" in *' ')
  COMP_WORDS+=("")
  COMP_CWORD=$((COMP_CWORD+1))
;; esac
[ "$COMP_CWORD" -lt 1 ] && exit 0
cmd="\${COMP_WORDS[0]}"
cur="\${COMP_WORDS[COMP_CWORD]}"
prev="\${COMP_WORDS[COMP_CWORD-1]}"
spec=$(complete -p "$cmd" 2>/dev/null)
if [ -z "$spec" ] && declare -F _completion_loader >/dev/null 2>&1; then
  _completion_loader "$cmd" 2>/dev/null
  spec=$(complete -p "$cmd" 2>/dev/null)
fi
[ -z "$spec" ] && exit 0
fn=$(printf '%s\\n' "$spec" | sed -n 's/.*-F \\([^ ]*\\).*/\\1/p')
[ -z "$fn" ] && exit 0
"$fn" "$cmd" "$cur" "$prev" 2>/dev/null
printf '%s\\n' "\${COMPREPLY[@]}"
`

// bashCompletions asks a real bash to run the command's programmable
// completion spec for the given input line, in cwd. Best-effort: short
// timeout, empty result on any failure (callers fall back to path completion).
async function bashCompletions(line: string, cwd: string): Promise<CompletionCandidate[]> {
  const trimmed = line.replace(/^[\s]+/, '')
  if (!trimmed) return []
  const out = await new Promise<string>((resolve) => {
    execFile(
      'bash',
      ['-c', BASH_COMPLETION_DRIVER, 'rysh-complete', trimmed],
      { encoding: 'utf8', timeout: 400, cwd },
      (err, stdout) => resolve(err ? '' : String(stdout))
    )
  })
  const seen = new Set<string>()
  const cands: CompletionCandidate[] = []
  for (const ln of out.split('\n')) {
    const value = ln.replace(/\s+$/, '')
    if (!value || seen.has(value)) continue
    seen.add(value)
    // Mark directories so a completed dir keeps the cursor ready for the
    // next path segment (trailing "/") like the built-in path completion.
    let isDir = false
    if (!value.includes(' ')) {
      try {
        let p = expandTilde(value)
        if (!isAbsolute(p)) p = join(cwd, p)
        isDir = (await fsp.stat(p)).isDirectory()
      } catch {
        /* not a path — fine */
      }
    }
    cands.push({ value, isDir })
    if (cands.length >= 200) break
  }
  cands.sort((a, b) => a.value.localeCompare(b.value))
  return cands
}

export async function getCompletions(opts: {
  shellPid: number
  token: string
  isFirstToken: boolean
  cwd?: string // OSC 7-reported live cwd (PaneSnapshot.shell_cwd)
  line?: string // full input line up to the cursor (programmable completion)
}): Promise<{ candidates: CompletionCandidate[] }> {
  const token = opts.token || ''
  const isPath = token.includes('/') || token.startsWith('~') || token.startsWith('.')
  if (opts.isFirstToken && !isPath) {
    return { candidates: await completeCommand(token) }
  }
  const cwd = await resolveCwd(opts.shellPid, opts.cwd)
  // Argument position: bash's programmable completion first (git branches,
  // ssh hosts, docker verbs, flags); built-in path completion as fallback.
  if (opts.line && opts.line.trim() !== '') {
    const prog = await bashCompletions(opts.line, cwd)
    if (prog.length > 0) return { candidates: prog }
  }
  return { candidates: await completePath(token, cwd) }
}

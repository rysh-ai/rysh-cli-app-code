// @vitest-environment node
//
// Regression test for the Linux packaging config (E-92 / E-94 / E-95): the
// lines in electron-builder.yml and resources/linux/ that keep the Chromium
// sandbox working on Ubuntu 24.04 and keep --no-sandbox out of desktop entries.
// Each of these was proven on a runner once; this is what stops a later edit
// from quietly undoing one of them.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config = yaml.load(read('electron-builder.yml')) as any
const PRODUCT = config.productName as string // "Rysh" -> /opt/Rysh
const EXECUTABLE = config.linux.executableName as string // "rysh-desktop"

/**
 * Render a deb script template the way electron-builder 25.1.8 does
 * (FpmTarget.writeConfigFile): ${name} macros, and an unknown macro aborts the
 * build — so rendering here also proves the template only uses known ones.
 */
function renderTemplate(path: string): string {
  const vars: Record<string, string> = { executable: EXECUTABLE, sanitizedProductName: PRODUCT, productFilename: PRODUCT }
  return read(path).replace(/\$\{([a-zA-Z]+)\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`Macro ${name} is not defined (${path})`)
    return vars[name]
  })
}

describe('electron-builder.yml', () => {
  it('linux.executableArgs is exactly ["--"] (E-95: no --no-sandbox in any desktop entry)', () => {
    // Unset or [] makes electron-builder 25.1.8 write `AppRun --no-sandbox %U`.
    expect(config.linux.executableArgs).toEqual(['--'])
  })

  it('deb afterInstall / afterRemove point at our two templates, and both exist', () => {
    expect(config.deb.afterInstall).toBe('resources/linux/after-install.tpl')
    expect(config.deb.afterRemove).toBe('resources/linux/after-remove.tpl')
    expect(existsSync(join(ROOT, config.deb.afterInstall))).toBe(true)
    expect(existsSync(join(ROOT, config.deb.afterRemove))).toBe(true)
  })

  it('afterPack is the launcher hook, and it exists', () => {
    expect(config.afterPack).toBe('scripts/build/after-pack-linux-launcher.cjs')
    expect(existsSync(join(ROOT, config.afterPack))).toBe(true)
  })

  it('the AppArmor profile is bundled with the Linux app', () => {
    expect(config.linux.extraResources).toContainEqual({ from: 'resources/linux/apparmor-profile', to: 'apparmor-profile' })
  })
})

describe('resources/linux/after-install.tpl (rendered as electron-builder renders it)', () => {
  const lines = renderTemplate('resources/linux/after-install.tpl').split('\n')
  const code = lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  const sandbox = `/opt/${PRODUCT}/chrome-sandbox`

  it(`sets ${sandbox} to root:root 4755`, () => {
    expect(code).toContain(`chown root:root '${sandbox}' || true`)
    expect(code).toContain(`chmod 4755 '${sandbox}' || true`)
    // and never downgrades it the way electron-builder's default does
    expect(code.filter((l) => /chmod 0?755 .*chrome-sandbox/.test(l))).toEqual([])
  })

  it('copies and loads the AppArmor profile ONLY inside the successful parse check', () => {
    const at = (re: RegExp): number[] => code.flatMap((l, i) => (re.test(l) ? [i] : []))
    const guard = at(/^if apparmor_parser --skip-kernel-load --debug "\$APPARMOR_SRC" >\/dev\/null 2>&1; then$/)
    const copy = at(/^cp -f "\$APPARMOR_SRC" "\$APPARMOR_DST"$/)
    const load = at(/apparmor_parser --replace/)
    expect(guard).toHaveLength(1)
    expect(copy).toHaveLength(1)
    expect(load).toHaveLength(1)

    // the guard's then-branch runs from the guard to its own `else`
    // (nested if/fi pairs inside it are skipped by depth counting)
    let depth = 0
    let elseAt = -1
    for (let i = guard[0] + 1; i < code.length; i++) {
      if (/^if /.test(code[i])) depth++
      else if (code[i] === 'fi') depth--
      else if (code[i] === 'else' && depth === 0) {
        elseAt = i
        break
      }
    }
    expect(elseAt).toBeGreaterThan(guard[0])
    expect(copy[0]).toBeGreaterThan(guard[0])
    expect(copy[0]).toBeLessThan(elseAt)
    expect(load[0]).toBeGreaterThan(copy[0])
    expect(load[0]).toBeLessThan(elseAt)
    // the else branch only explains the skip
    expect(code[elseAt + 1]).toMatch(/^echo .*skipping it"$/)
  })

  it('the parse check itself sits behind "is AppArmor here at all"', () => {
    const outer = code.findIndex((l) => l.startsWith('if hash apparmor_parser') && l.includes('/etc/apparmor.d'))
    const guard = code.findIndex((l) => l.startsWith('if apparmor_parser --skip-kernel-load'))
    expect(outer).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThan(outer)
  })

  it('keeps what electron-builder\'s default postinst did (alternatives link, desktop db)', () => {
    expect(code).toContain(
      `update-alternatives --install '/usr/bin/${EXECUTABLE}' '${EXECUTABLE}' '/opt/${PRODUCT}/${EXECUTABLE}' 100 || ln -sf '/opt/${PRODUCT}/${EXECUTABLE}' '/usr/bin/${EXECUTABLE}'`,
    )
    expect(code).toContain('update-desktop-database /usr/share/applications || true')
  })
})

describe('resources/linux/after-remove.tpl', () => {
  const code = renderTemplate('resources/linux/after-remove.tpl')

  it('removes the profile only on remove|purge, not on upgrade', () => {
    expect(code).toMatch(/case "\$1" in\s+remove\|purge\)[\s\S]*apparmor_parser --remove[\s\S]*rm -f "\$APPARMOR_DST"[\s\S]*;;\s+esac/)
  })
})

describe('resources/linux/apparmor-profile', () => {
  const profile = read('resources/linux/apparmor-profile')

  it(`attaches to /opt/${PRODUCT}/${EXECUTABLE}.bin — the real binary behind the E-94 launcher`, () => {
    const header = profile.split('\n').filter((l) => l.startsWith('profile '))
    expect(header).toEqual([`profile ${EXECUTABLE} /opt/${PRODUCT}/${EXECUTABLE}.bin flags=(unconfined) {`])
  })

  it('grants userns and declares abi 4.0', () => {
    expect(profile).toMatch(/^\s+userns,$/m)
    expect(profile).toMatch(/^abi <abi\/4\.0>,$/m)
  })
})

describe('scripts/build/after-pack-linux-launcher.cjs', () => {
  const require = createRequire(__filename)
  const hook = require(join(ROOT, 'scripts/build/after-pack-linux-launcher.cjs')).default as (c: object) => Promise<void>

  function appDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'rysh-afterpack-'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, EXECUTABLE), 'ELF-PLACEHOLDER')
    return d
  }
  const ctx = (platform: string, dir: string): object => ({
    electronPlatformName: platform,
    appOutDir: dir,
    packager: { executableName: EXECUTABLE, info: { projectDir: ROOT } },
  })

  it('linux: moves the binary to <exe>.bin and installs launcher.sh, 0755, idempotently', async () => {
    const d = appDir()
    try {
      await hook(ctx('linux', d))
      await hook(ctx('linux', d)) // a second run must not wrap the launcher
      expect(readFileSync(join(d, `${EXECUTABLE}.bin`), 'utf8')).toBe('ELF-PLACEHOLDER')
      expect(readFileSync(join(d, EXECUTABLE), 'utf8')).toBe(read('resources/linux/launcher.sh'))
      expect(statSync(join(d, EXECUTABLE)).mode & 0o777).toBe(0o755)
      // the launcher execs exactly the name the hook produced and the profile attaches to
      expect(read('resources/linux/launcher.sh')).toContain('BIN="$HERE/rysh-desktop.bin"')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('darwin: no-op', async () => {
    const d = appDir()
    try {
      await hook(ctx('darwin', d))
      expect(existsSync(join(d, `${EXECUTABLE}.bin`))).toBe(false)
      expect(readFileSync(join(d, EXECUTABLE), 'utf8')).toBe('ELF-PLACEHOLDER')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

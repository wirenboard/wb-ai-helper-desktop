import type { SshPool } from './ssh.ts'
import type { Controller } from './discovery.ts'

const SECTION = '===WB-AUDIT==='
const COLLECT_SCRIPT = [
  `echo ${SECTION}fw`,
  'cat /etc/wb-fw-version 2>/dev/null || true',
  `echo ${SECTION}release`,
  'cat /usr/lib/wb-release 2>/dev/null || true',
  `echo ${SECTION}manual`,
  'apt-mark showmanual 2>/dev/null | sort',
  `echo ${SECTION}installed`,
  "dpkg-query -W -f='${Package}\\n' 2>/dev/null | sort",
  `echo ${SECTION}enabled`,
  "systemctl list-unit-files --state=enabled --no-legend 2>/dev/null | awk '{print $1}' | sort",
  `echo ${SECTION}units`,
  "find /etc/systemd/system -maxdepth 2 -name '*.service' -type f 2>/dev/null | sort",
  `echo ${SECTION}cron`,
  "for d in /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /var/spool/cron/crontabs; do " +
    "ls -A \"$d\" 2>/dev/null | grep -v '^\\.placeholder$' | sed \"s|^|$d/|\"; done",
  `echo ${SECTION}opt`,
  'ls -A /opt 2>/dev/null',
  `echo ${SECTION}localbin`,
  'ls -A /usr/local/bin 2>/dev/null',
  `echo ${SECTION}localsbin`,
  'ls -A /usr/local/sbin 2>/dev/null',
  `echo ${SECTION}symlinks`,
  'for p in /etc/wb-rules /etc/wb-rules-modules /etc/wb-mqtt-serial.conf /etc/wb-mqtt-serial.conf.d; do ' +
    'echo "$p|$(readlink -f $p 2>/dev/null)"; done',
  `echo ${SECTION}mntdata`,
  'for d in /mnt/data/*/; do case "$(basename "$d")" in etc|var|root|snapshots|backups|uploads|.docker|ai) continue;; *) du -sh "$d" 2>/dev/null;; esac; done',
  `echo ${SECTION}dpkg`,
  "dpkg --verify 2>/dev/null | grep -v -E '/usr/share/(doc|locale|man|lintian|gtk-doc|gnome|info|help)'",
  `echo ${SECTION}end`
].join('; ')

function splitSections(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let current = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith(SECTION)) {
      current = line.slice(SECTION.length)
      out[current] = []
      continue
    }
    if (current && line !== '') out[current]!.push(line)
  }
  return out
}

interface ModifiedPath {
  path: string
  flags: string
  isConffile: boolean
}

function parseDpkgVerify(lines: string[]): ModifiedPath[] {
  const out: ModifiedPath[] = []
  for (const line of lines) {
    const m = line.match(/^(\S+)(?:\s+(\S))?\s+(\/.*)$/)
    if (!m) continue
    out.push({ flags: m[1]!, isConffile: (m[2] ?? '') === 'c', path: m[3]! })
  }
  return out
}

interface ReleaseInfo {
  releaseName: string
  suite: string
  target: string
}

interface MntdataDir {
  path: string
  size: string
}

export interface ControllerState {
  fwVersion: string
  release: ReleaseInfo
  manualPackages: string[]
  installedPackages: string[]
  enabledUnits: string[]
  customSystemdUnits: string[]
  cronEntries: string[]
  opt: string[]
  localbin: string[]
  localsbin: string[]
  symlinks: Record<string, string>
  modifiedPaths: ModifiedPath[]
  mntdataUserDirs: MntdataDir[]
}

async function collectState(ssh: SshPool, c: Controller): Promise<ControllerState> {
  const r = await ssh.exec(c, COLLECT_SCRIPT, 60000)
  const sec = splitSections(r.stdout)

  const symlinks: Record<string, string> = {}
  for (const line of sec['symlinks'] ?? []) {
    const [path, actual] = line.split('|')
    if (path) symlinks[path] = actual ?? ''
  }

  const releaseKv: Record<string, string> = {}
  for (const line of sec['release'] ?? []) {
    const eq = line.indexOf('=')
    if (eq > 0) releaseKv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const release: ReleaseInfo = {
    releaseName: releaseKv['RELEASE_NAME'] ?? '',
    suite: releaseKv['SUITE'] ?? '',
    target: releaseKv['TARGET'] ?? ''
  }

  const mntdataUserDirs: MntdataDir[] = []
  for (const line of sec['mntdata'] ?? []) {
    const m = line.match(/^(\S+)\s+(.+?)\/?\s*$/)
    if (m) mntdataUserDirs.push({ size: m[1]!, path: m[2]! })
  }

  return {
    fwVersion: (sec['fw']?.[0] ?? '').trim(),
    release,
    manualPackages: sec['manual'] ?? [],
    installedPackages: sec['installed'] ?? [],
    enabledUnits: sec['enabled'] ?? [],
    customSystemdUnits: sec['units'] ?? [],
    cronEntries: sec['cron'] ?? [],
    opt: sec['opt'] ?? [],
    localbin: sec['localbin'] ?? [],
    localsbin: sec['localsbin'] ?? [],
    symlinks,
    modifiedPaths: parseDpkgVerify(sec['dpkg'] ?? []),
    mntdataUserDirs
  }
}

export async function runAudit(ssh: SshPool, c: Controller): Promise<ControllerState & { sn: string }> {
  const state = await collectState(ssh, c)
  return { sn: c.sn, ...state }
}

const SNAPSHOT_DIR = '/mnt/data/ai/wb-ai-helper/snapshots'

interface SnapshotFile {
  _comment: string
  sn: string
  takenAt: string
  fwVersion: string
  release: ReleaseInfo
  manualPackages: string[]
  enabledUnits: string[]
  customSystemdUnits: string[]
  cronEntries: string[]
  opt: string[]
  localbin: string[]
  localsbin: string[]
  symlinks: Record<string, string>
  modifiedPaths: ModifiedPath[]
  mntdataUserDirs?: MntdataDir[]
}

export interface SnapshotResult {
  sn: string
  path: string
  takenAt: string
  fwVersion: string
  release: ReleaseInfo
  totals: {
    manualPackages: number
    enabledUnits: number
    customSystemdUnits: number
    cronEntries: number
    customFiles: number
    modifiedPaths: number
    symlinks: number
  }
  hint: string
}

export async function runSnapshot(ssh: SshPool, c: Controller): Promise<SnapshotResult> {
  const state = await collectState(ssh, c)
  const takenAt = new Date().toISOString()
  const snapshot: SnapshotFile = {
    _comment: `Слепок контроллера ${c.sn} от ${takenAt}, fw ${state.fwVersion}. Создан через save_state_for_diff.`,
    sn: c.sn,
    takenAt,
    fwVersion: state.fwVersion,
    release: state.release,
    manualPackages: state.manualPackages,
    enabledUnits: state.enabledUnits,
    customSystemdUnits: state.customSystemdUnits,
    cronEntries: state.cronEntries,
    opt: state.opt,
    localbin: state.localbin,
    localsbin: state.localsbin,
    symlinks: state.symlinks,
    modifiedPaths: state.modifiedPaths,
    mntdataUserDirs: state.mntdataUserDirs
  }
  const filename = `snapshot-${takenAt.replace(/[:.]/g, '-')}.json`
  const path = `${SNAPSHOT_DIR}/${filename}`
  await ssh.exec(c, `mkdir -p ${SNAPSHOT_DIR}`, 5000)
  await ssh.writeFile(c, path, JSON.stringify(snapshot, null, 2) + '\n')
  return {
    sn: c.sn,
    path,
    takenAt,
    fwVersion: state.fwVersion,
    release: state.release,
    totals: {
      manualPackages: snapshot.manualPackages.length,
      enabledUnits: snapshot.enabledUnits.length,
      customSystemdUnits: snapshot.customSystemdUnits.length,
      cronEntries: snapshot.cronEntries.length,
      customFiles: state.opt.length + state.localbin.length + state.localsbin.length,
      modifiedPaths: snapshot.modifiedPaths.length,
      symlinks: Object.keys(snapshot.symlinks).length
    },
    hint:
      `Слепок сохранён на контроллере: ${path}. ` +
      `Позже вызови diff_snapshot(sn, beforePath="${path}"), чтобы узнать что добавилось/убавилось. ` +
      `/mnt/data переживает FIT-update, файл не потеряется.`
  }
}

function diffArrays(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((x) => !beforeSet.has(x)),
    removed: before.filter((x) => !afterSet.has(x))
  }
}

export interface DiffResult {
  sn: string
  before: { path: string; takenAt: string; fwVersion: string; release: ReleaseInfo }
  after: { takenAt: string; fwVersion: string; release: ReleaseInfo }
  fwChanged: boolean
  packages: { added: string[]; removed: string[] }
  enabledUnits: { added: string[]; removed: string[] }
  customSystemdUnits: { added: string[]; removed: string[] }
  cronEntries: { added: string[]; removed: string[] }
  customFiles: {
    '/opt': { added: string[]; removed: string[] }
    '/usr/local/bin': { added: string[]; removed: string[] }
    '/usr/local/sbin': { added: string[]; removed: string[] }
  }
  symlinksChanged: { path: string; before: string; after: string }[]
  modifiedPaths: { added: ModifiedPath[]; removed: ModifiedPath[] }
  summary: { clean: boolean; changes: number }
  hint: string
}

export async function runDiffSnapshot(ssh: SshPool, c: Controller, beforePath: string): Promise<DiffResult> {
  if (!beforePath.startsWith('/')) {
    throw new Error('beforePath должен быть абсолютным')
  }
  const raw = await ssh.readFile(c, beforePath, 256 * 1024)
  let before: SnapshotFile
  try {
    before = JSON.parse(raw.content) as SnapshotFile
  } catch (e) {
    throw new Error(
      `не удалось распарсить ${beforePath}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!Array.isArray(before.manualPackages) || !Array.isArray(before.enabledUnits)) {
    throw new Error(`${beforePath} не похож на слепок save_state_for_diff`)
  }

  const state = await collectState(ssh, c)
  const takenAt = new Date().toISOString()

  const packages = diffArrays(before.manualPackages, state.manualPackages)
  const enabledUnits = diffArrays(before.enabledUnits, state.enabledUnits)
  const customSystemdUnits = diffArrays(before.customSystemdUnits ?? [], state.customSystemdUnits)
  const cronEntries = diffArrays(before.cronEntries ?? [], state.cronEntries)
  const customFiles = {
    '/opt': diffArrays(before.opt ?? [], state.opt),
    '/usr/local/bin': diffArrays(before.localbin ?? [], state.localbin),
    '/usr/local/sbin': diffArrays(before.localsbin ?? [], state.localsbin)
  }

  const symlinksChanged: DiffResult['symlinksChanged'] = []
  const beforeSymlinks = before.symlinks ?? {}
  for (const [path, afterVal] of Object.entries(state.symlinks)) {
    const was = beforeSymlinks[path]
    if (was !== undefined && was !== afterVal) {
      symlinksChanged.push({ path, before: was, after: afterVal })
    }
  }

  const beforePathsMap = new Map((before.modifiedPaths ?? []).map((m) => [m.path, m]))
  const afterPathsMap = new Map(state.modifiedPaths.map((m) => [m.path, m]))
  const modifiedAdded = state.modifiedPaths.filter((m) => !beforePathsMap.has(m.path))
  const modifiedRemoved = (before.modifiedPaths ?? []).filter((m) => !afterPathsMap.has(m.path))

  const changes =
    packages.added.length + packages.removed.length +
    enabledUnits.added.length + enabledUnits.removed.length +
    customSystemdUnits.added.length + customSystemdUnits.removed.length +
    cronEntries.added.length + cronEntries.removed.length +
    customFiles['/opt'].added.length + customFiles['/opt'].removed.length +
    customFiles['/usr/local/bin'].added.length + customFiles['/usr/local/bin'].removed.length +
    customFiles['/usr/local/sbin'].added.length + customFiles['/usr/local/sbin'].removed.length +
    symlinksChanged.length +
    modifiedAdded.length + modifiedRemoved.length

  return {
    sn: c.sn,
    before: {
      path: beforePath,
      takenAt: before.takenAt ?? '',
      fwVersion: before.fwVersion ?? '',
      release: before.release ?? { releaseName: '', suite: '', target: '' }
    },
    after: { takenAt, fwVersion: state.fwVersion, release: state.release },
    fwChanged: !!before.fwVersion && before.fwVersion !== state.fwVersion,
    packages,
    enabledUnits,
    customSystemdUnits,
    cronEntries,
    customFiles,
    symlinksChanged,
    modifiedPaths: { added: modifiedAdded, removed: modifiedRemoved },
    summary: { clean: changes === 0, changes },
    hint:
      changes === 0
        ? 'Между слепками изменений нет.'
        : 'Пройдись по блокам: packages.added — что поставилось руками, customFiles.added — что появилось в /opt и /usr/local, modifiedPaths.added — какие системные файлы изменились. По каждой записи спроси пользователя: нужно это сохранять в бэкап?'
  }
}

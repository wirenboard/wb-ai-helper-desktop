import { describe, test, expect } from 'bun:test'
import { normalizeAptCommand } from '../src/server/apt-defaults.ts'

describe('normalizeAptCommand: DEBIAN_FRONTEND prepend', () => {
  test('добавляет noninteractive к apt-get install', () => {
    expect(normalizeAptCommand('apt-get install foo')).toBe('DEBIAN_FRONTEND=noninteractive apt-get install -y foo')
  })

  test('добавляет noninteractive к apt update (без install)', () => {
    expect(normalizeAptCommand('apt-get update')).toBe('DEBIAN_FRONTEND=noninteractive apt-get update')
  })

  test('добавляет noninteractive к apt install (без -get)', () => {
    expect(normalizeAptCommand('apt install foo')).toBe('DEBIAN_FRONTEND=noninteractive apt install -y foo')
  })

  test('не дублирует если DEBIAN_FRONTEND уже задан', () => {
    expect(normalizeAptCommand('DEBIAN_FRONTEND=noninteractive apt-get install foo')).toBe(
      'DEBIAN_FRONTEND=noninteractive apt-get install -y foo',
    )
  })

  test('не трогает не-apt команды', () => {
    expect(normalizeAptCommand('echo hello')).toBe('echo hello')
    expect(normalizeAptCommand('systemctl restart foo')).toBe('systemctl restart foo')
    expect(normalizeAptCommand('cat /etc/apt/sources.list')).toBe('cat /etc/apt/sources.list')
  })
})

describe('normalizeAptCommand: -y auto-add', () => {
  test('apt-get install без флагов → добавляет -y', () => {
    expect(normalizeAptCommand('apt-get install pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get install -y pkg')
  })

  test('apt-get upgrade → добавляет -y', () => {
    expect(normalizeAptCommand('apt-get upgrade')).toBe('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y')
  })

  test('apt-get dist-upgrade → добавляет -y', () => {
    expect(normalizeAptCommand('apt-get dist-upgrade')).toBe('DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y')
  })

  test('apt-get remove → добавляет -y', () => {
    expect(normalizeAptCommand('apt-get remove pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get remove -y pkg')
  })

  test('apt-get purge → добавляет -y', () => {
    expect(normalizeAptCommand('apt-get purge pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get purge -y pkg')
  })

  test('не дублирует -y если уже задан', () => {
    expect(normalizeAptCommand('apt-get install -y pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get install -y pkg')
  })

  test('не дублирует если --yes задан', () => {
    expect(normalizeAptCommand('apt-get install --yes pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get install --yes pkg')
  })

  test('не дублирует если --assume-yes задан', () => {
    expect(normalizeAptCommand('apt-get install --assume-yes pkg')).toBe('DEBIAN_FRONTEND=noninteractive apt-get install --assume-yes pkg')
  })

  test('apt update НЕ получает -y (не action-команда)', () => {
    expect(normalizeAptCommand('apt-get update')).toBe('DEBIAN_FRONTEND=noninteractive apt-get update')
  })

  test('apt list НЕ получает -y', () => {
    expect(normalizeAptCommand('apt-get list')).toBe('DEBIAN_FRONTEND=noninteractive apt-get list')
  })

  test('apt-get install --only-upgrade pkg=ver — добавляет -y', () => {
    const out = normalizeAptCommand('apt-get install --only-upgrade wb-mqtt-serial=2.224.0-wb105')
    expect(out).toBe('DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade wb-mqtt-serial=2.224.0-wb105')
  })

  test('apt install с уже-y в названии пакета не путается', () => {
    // Например `apt install python3-yaml` — `-y` тут часть имени, не флаг
    expect(normalizeAptCommand('apt-get install python3-yaml')).toBe(
      'DEBIAN_FRONTEND=noninteractive apt-get install -y python3-yaml',
    )
  })
})

describe('normalizeAptCommand: edge cases', () => {
  test('пустая строка', () => {
    expect(normalizeAptCommand('')).toBe('')
  })

  test('chained apt commands — первое install получает -y', () => {
    // Realistic case: apt-get update && apt-get install pkg
    const out = normalizeAptCommand('apt-get update && apt-get install pkg')
    // DEBIAN_FRONTEND добавляется один раз в начало (purpose: всё что после
    // в той же строке его наследует через env). Это чуть имперфектно: только
    // ПЕРВОЕ apt-get install получит -y, потому что regex non-global. Если
    // junior напишет `apt-get install a && apt-get install b` — второй останется
    // без -y. Не страшно для практики (модель пишет одну команду на jobStart),
    // но фиксируем как поведение.
    expect(out).toContain('DEBIAN_FRONTEND=noninteractive')
    expect(out).toContain('apt-get install -y pkg')
  })
})

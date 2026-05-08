// Авто-нормализация apt-команд при запуске через ssh_exec_async:
// добавляем DEBIAN_FRONTEND=noninteractive (если ещё нет) и -y к действиям
// install/upgrade/remove/etc (если нет ни -y, ни --yes, ни --assume-yes).
//
// Зачем: apt в noninteractive-режиме без -y либо падает на «Do you want
// to continue?», либо ловит default=N (зависит от пакета и dpkg-config) —
// в реальном кейсе на A25NDEMJ обновление wb-mqtt-serial без -y не
// применилось, пакет остался на устаревшей 2.146.0 пока юзер не
// заметил. Безопаснее всегда ставить -y, чем ждать что модель вспомнит.

const APT_ACTION_RE = /\b(apt(?:-get)?\s+)(install|upgrade|dist-upgrade|full-upgrade|remove|purge)\b/

// `(?<![A-Za-z0-9-])` — отрицательный взгляд назад, чтобы не считать
// `--noninteractive-y` или `something-y` за -y флаг.
const YES_FLAG_RE = /(?<![A-Za-z0-9-])(-y|--yes|--assume-yes)\b/

/** Нормализовать apt-команду перед отправкой в ssh_exec_async/jobStart.
 *  Возвращает либо ту же строку (если apt не упомянут или всё уже в норме),
 *  либо modified — с добавленным DEBIAN_FRONTEND= и/или -y. */
export function normalizeAptCommand(command: string): string {
  let out = command
  // 1. DEBIAN_FRONTEND=noninteractive — для любой apt(-get) команды,
  // не только install/upgrade. Например `apt-get update` тоже выигрывает
  // (некоторые пакеты при postinst могут ругаться).
  if (/\bapt(?:-get)?\s/.test(out) && !out.includes('DEBIAN_FRONTEND')) {
    out = `DEBIAN_FRONTEND=noninteractive ${out}`
  }
  // 2. Авто -y для action-команд (install/upgrade/remove/purge/...).
  if (APT_ACTION_RE.test(out) && !YES_FLAG_RE.test(out)) {
    out = out.replace(APT_ACTION_RE, '$1$2 -y')
  }
  return out
}

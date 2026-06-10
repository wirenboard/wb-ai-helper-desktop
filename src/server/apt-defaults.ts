// Auto-normalize apt commands run via ssh_exec_async: add
// DEBIAN_FRONTEND=noninteractive (if absent) and -y to install/upgrade/
// remove/etc actions (if none of -y, --yes, --assume-yes is present).
//
// Why: noninteractive apt without -y either fails on "Do you want to
// continue?" or hits default=N (depends on package and dpkg config) — in a
// real case on A25NDEMJ a wb-mqtt-serial upgrade without -y silently didn't
// apply, the package stayed on stale 2.146.0 until the user noticed. Always
// forcing -y is safer than hoping the model remembers.

const APT_ACTION_RE = /\b(apt(?:-get)?\s+)(install|upgrade|dist-upgrade|full-upgrade|remove|purge)\b/

// `(?<![A-Za-z0-9-])` — negative lookbehind so `--noninteractive-y` or
// `something-y` isn't mistaken for a -y flag.
const YES_FLAG_RE = /(?<![A-Za-z0-9-])(-y|--yes|--assume-yes)\b/

/** Normalize an apt command before sending to ssh_exec_async/jobStart.
 *  Returns the same string (if apt isn't mentioned or it's already fine),
 *  or a modified one with DEBIAN_FRONTEND= and/or -y added. */
export function normalizeAptCommand(command: string): string {
  let out = command
  // 1. DEBIAN_FRONTEND=noninteractive — for any apt(-get) command, not just
  // install/upgrade. E.g. `apt-get update` benefits too (some packages may
  // complain during postinst).
  if (/\bapt(?:-get)?\s/.test(out) && !out.includes('DEBIAN_FRONTEND')) {
    out = `DEBIAN_FRONTEND=noninteractive ${out}`
  }
  // 2. Auto -y for action commands (install/upgrade/remove/purge/...).
  if (APT_ACTION_RE.test(out) && !YES_FLAG_RE.test(out)) {
    out = out.replace(APT_ACTION_RE, '$1$2 -y')
  }
  return out
}

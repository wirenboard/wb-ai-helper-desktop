// Render a multi-series time-series chart via Vega-Lite SSR.
// Returns SVG bytes; frontend treats `image/svg+xml` as an inline image.

import * as vega from 'vega'
import { compile } from 'vega-lite'
import type { TopLevelSpec } from 'vega-lite'
import type { HistorySeries } from './tools.ts'

interface FlatPoint {
  t: string          // ISO timestamp (vega-lite handles temporal axis natively)
  v: number
  series: string     // series label (becomes legend / colour key)
  unit: string       // grouping label for twin Y-axis (one axis per unit)
}

/**
 * Decide which series share a Y-axis. Series with identical `units` always
 * share. Series with no units fall on the primary axis.
 *
 * If exactly two distinct unit groups appear and their value ranges don't
 * overlap, vega-lite renders independent Y-axes via `resolve.scale.y='independent'`.
 */
function hasIndependentY(series: HistorySeries[]): boolean {
  const groups = new Map<string, [number, number]>()
  for (const s of series) {
    if (!s.points.length) continue
    const key = s.units ?? ''
    const cur = groups.get(key)
    if (!cur) groups.set(key, [s.min, s.max])
    else groups.set(key, [Math.min(cur[0], s.min), Math.max(cur[1], s.max)])
  }
  if (groups.size !== 2) return false
  const [a, b] = [...groups.values()]
  if (!a || !b) return false
  // Non-overlapping ranges → independent axes make sense
  return a[1] < b[0] || b[1] < a[0]
}

function pickTimeFormat(durationSec: number): string {
  if (durationSec <= 3600)         return '%H:%M:%S'
  if (durationSec <= 86400)        return '%H:%M'
  if (durationSec <= 7 * 86400)    return '%d.%m %H:%M'
  return '%d.%m'
}

export async function renderHistoryChart(
  series: HistorySeries[],
  from: number,
  to: number,
  title: string,
  ylabel: string,
): Promise<string> {
  const nonEmpty = series.filter(s => s.points.length > 0)

  // Flatten into a single dataset; vega-lite groups by `series` for colour
  const values: FlatPoint[] = []
  for (const s of nonEmpty) {
    const seriesLabel = s.units ? `${s.label} (${s.units})` : s.label
    const unit = s.units ?? ''
    for (const p of s.points) {
      values.push({ t: new Date(p.t * 1000).toISOString(), v: p.v, series: seriesLabel, unit })
    }
  }

  const durationSec = to - from
  const timeFormat = pickTimeFormat(durationSec)

  const useTwinAxis = hasIndependentY(nonEmpty)

  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 880,
    height: 360,
    background: '#ffffff',
    title: title ? { text: title, fontSize: 14, color: '#1e293b' } : undefined,
    config: {
      view: { stroke: 'transparent' },
      axis: { labelColor: '#64748b', titleColor: '#64748b', gridColor: '#e2e8f0' },
      legend: { labelColor: '#334155', titleColor: '#334155' },
    },
    data: { values },
    mark: { type: 'line', strokeWidth: 1.6, interpolate: 'monotone' },
    encoding: {
      x: {
        field: 't',
        type: 'temporal',
        axis: { title: null, format: timeFormat, labelAngle: -30, labelOverlap: 'parity' },
        scale: { domain: [new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()] },
      },
      y: {
        field: 'v',
        type: 'quantitative',
        axis: { title: ylabel || null, grid: true },
        scale: { zero: false, nice: true },
      },
      color: {
        field: 'series',
        type: 'nominal',
        scale: { range: ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'] },
        legend: nonEmpty.length > 1 ? { title: null, orient: 'bottom', columns: 0 } : null,
      },
    },
  }

  if (useTwinAxis) {
    // Drive paired axes off the `unit` grouping
    ;(spec as any).encoding.y.facet = undefined
    ;(spec as any).resolve = { scale: { y: 'independent' } }
    ;(spec as any).layer = nonEmpty.map((s, idx) => ({
      mark: { type: 'line', strokeWidth: 1.6, interpolate: 'monotone' },
      transform: [{ filter: `datum.unit === '${(s.units ?? '').replace(/'/g, "\\'")}'` }],
      encoding: {
        x: spec.encoding!.x,
        y: {
          field: 'v',
          type: 'quantitative',
          axis: {
            title: s.units || ylabel || null,
            orient: idx === 0 ? 'left' : 'right',
            grid: idx === 0,
          },
          scale: { zero: false, nice: true },
        },
        color: spec.encoding!.color,
      },
    }))
    delete (spec as any).mark
    delete (spec as any).encoding
  }

  if (!nonEmpty.length) {
    // Empty placeholder — just an info text
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 240" font-family="system-ui,sans-serif">` +
      `<rect width="880" height="240" fill="#ffffff"/>` +
      `<text x="440" y="120" text-anchor="middle" fill="#64748b" font-size="14">Нет данных за выбранный период</text>` +
      `</svg>`
  }

  const compiled = compile(spec).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  return await view.toSVG()
}

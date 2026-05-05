// Render a multi-series time-series chart via Vega-Lite SSR.
// Returns SVG string; the frontend renders `image/svg+xml` inline as an image.

import * as vega from 'vega'
import { compile } from 'vega-lite'
import type { TopLevelSpec } from 'vega-lite'
import type { HistorySeries } from './tools.ts'

interface FlatPoint {
  t: string          // ISO timestamp
  v: number          // raw value
  vn: number         // normalised value, 0..1 (used for 3+ unit-group fallback)
  series: string     // series label (legend key)
  unit: string       // grouping key for axis assignment
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

function pickTimeFormat(durationSec: number): string {
  if (durationSec <= 3600)         return '%H:%M:%S'
  if (durationSec <= 86400)        return '%H:%M'
  if (durationSec <= 7 * 86400)    return '%d.%m %H:%M'
  return '%d.%m'
}

function emptySvg(message: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 240" font-family="system-ui,sans-serif">' +
    '<rect width="880" height="240" fill="#ffffff"/>' +
    `<text x="440" y="120" text-anchor="middle" fill="#64748b" font-size="14">${message}</text>` +
    '</svg>'
  )
}

/** Group series by `units`. Series without units share the empty-string group. */
function groupByUnits(series: HistorySeries[]): Map<string, HistorySeries[]> {
  const groups = new Map<string, HistorySeries[]>()
  for (const s of series) {
    const key = s.units ?? ''
    const arr = groups.get(key)
    if (arr) arr.push(s)
    else groups.set(key, [s])
  }
  return groups
}

function seriesLabel(s: HistorySeries): string {
  return s.units ? `${s.label} (${s.units})` : s.label
}

/** Build a flat dataset. Each row carries raw + normalised value plus grouping keys. */
function flatten(nonEmpty: HistorySeries[]): FlatPoint[] {
  const out: FlatPoint[] = []
  for (const s of nonEmpty) {
    const range = s.max - s.min
    const norm = (v: number) => (range > 0 ? (v - s.min) / range : 0.5)
    const label = seriesLabel(s)
    const unit = s.units ?? ''
    for (const p of s.points) {
      out.push({ t: new Date(p.t * 1000).toISOString(), v: p.v, vn: norm(p.v), series: label, unit })
    }
  }
  return out
}

export async function renderHistoryChart(
  series: HistorySeries[],
  from: number,
  to: number,
  title: string,
  ylabel: string,
): Promise<string> {
  const nonEmpty = series.filter(s => s.points.length > 0)
  if (!nonEmpty.length) return emptySvg('Нет данных за выбранный период')

  const values = flatten(nonEmpty)
  const groups = groupByUnits(nonEmpty)
  const groupCount = groups.size
  const durationSec = to - from
  const timeFormat = pickTimeFormat(durationSec)

  const xScaleDomain = [new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()]
  const xEnc = {
    field: 't',
    type: 'temporal',
    axis: { title: null, format: timeFormat, labelAngle: -30, labelOverlap: 'parity' },
    scale: { domain: xScaleDomain },
  } as const

  const colorRange = nonEmpty.map((_, i) => PALETTE[i % PALETTE.length] ?? '#000')
  const colorEnc = {
    field: 'series',
    type: 'nominal',
    scale: { domain: nonEmpty.map(seriesLabel), range: colorRange },
    legend: nonEmpty.length > 1 ? { title: null, orient: 'bottom', columns: 0 } : null,
  } as const

  const baseConfig = {
    view: { stroke: 'transparent' },
    axis: { labelColor: '#64748b', titleColor: '#64748b', gridColor: '#e2e8f0' },
    legend: { labelColor: '#334155', titleColor: '#334155' },
  } as const

  const baseSpec: Omit<TopLevelSpec, 'data'> = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 880,
    height: 360,
    background: '#ffffff',
    title: title ? { text: title, fontSize: 14, color: '#1e293b' } : undefined,
    config: baseConfig,
  }

  let spec: TopLevelSpec

  if (groupCount === 1) {
    // Single Y axis — all series share units
    const onlyUnit = [...groups.keys()][0] ?? ''
    spec = {
      ...baseSpec,
      data: { values },
      mark: { type: 'line', strokeWidth: 1.6, interpolate: 'monotone' },
      encoding: {
        x: xEnc,
        y: {
          field: 'v',
          type: 'quantitative',
          axis: { title: ylabel || onlyUnit || null, grid: true },
          scale: { zero: false, nice: true },
        },
        color: colorEnc,
      },
    } as TopLevelSpec
  } else if (groupCount === 2) {
    // Twin Y axes — one layer per unit group
    const groupArr = [...groups.entries()]
    const layers = groupArr.map(([unit, grpSeries], gIdx) => {
      const labels = grpSeries.map(seriesLabel)
      const filterExpr = labels.map(l => `'${l.replace(/'/g, "\\'")}'`).join(',')
      return {
        transform: [{ filter: `indexof([${filterExpr}], datum.series) >= 0` }],
        mark: { type: 'line', strokeWidth: 1.6, interpolate: 'monotone' },
        encoding: {
          x: xEnc,
          y: {
            field: 'v',
            type: 'quantitative',
            axis: {
              title: unit || (gIdx === 0 ? ylabel : ''),
              orient: gIdx === 0 ? 'left' : 'right',
              grid: gIdx === 0,
            },
            scale: { zero: false, nice: true },
          },
          color: colorEnc,
        },
      }
    })
    spec = {
      ...baseSpec,
      data: { values },
      layer: layers as any,
      resolve: { scale: { y: 'independent' } },
    } as TopLevelSpec
  } else {
    // 3+ unit groups → normalise everything to 0..1, show actual ranges in legend
    const seriesWithRange = nonEmpty.map(s => ({
      label: seriesLabel(s),
      range: `${s.min.toFixed(2)} … ${s.max.toFixed(2)}${s.units ? ` ${s.units}` : ''}`,
    }))
    const legendLabels = seriesWithRange.map(x => `${x.label}: ${x.range}`)
    const labelMap = Object.fromEntries(seriesWithRange.map((x, i) => [x.label, legendLabels[i]]))
    const normedValues = values.map(p => ({ ...p, seriesLegend: labelMap[p.series] ?? p.series }))
    spec = {
      ...baseSpec,
      data: { values: normedValues },
      mark: { type: 'line', strokeWidth: 1.6, interpolate: 'monotone' },
      encoding: {
        x: xEnc,
        y: {
          field: 'vn',
          type: 'quantitative',
          axis: { title: 'нормализовано (0…1)', grid: true, format: '.1f' },
          scale: { domain: [0, 1] },
        },
        color: {
          field: 'seriesLegend',
          type: 'nominal',
          scale: { domain: legendLabels, range: colorRange },
          legend: { title: null, orient: 'bottom', columns: 1 },
        },
      },
    } as TopLevelSpec
  }

  const compiled = compile(spec).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  return await view.toSVG()
}

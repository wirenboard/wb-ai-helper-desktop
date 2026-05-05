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

/** Strip a common `device/` prefix from labels so the legend shows only what differs. */
function buildLabelMap(series: HistorySeries[]): Map<HistorySeries, string> {
  const devices = new Set<string>()
  for (const s of series) {
    const slash = s.label.indexOf('/')
    devices.add(slash > 0 ? s.label.slice(0, slash) : '')
  }
  const stripDevice = devices.size === 1 && !devices.has('')
  const map = new Map<HistorySeries, string>()
  for (const s of series) {
    const slash = s.label.indexOf('/')
    const channel = slash > 0 && stripDevice ? s.label.slice(slash + 1) : s.label
    const label = s.units ? `${channel}, ${s.units}` : channel
    map.set(s, label)
  }
  return map
}

/** Build a flat dataset. Each row carries raw + normalised value plus grouping keys. */
function flatten(nonEmpty: HistorySeries[], labels: Map<HistorySeries, string>): FlatPoint[] {
  const out: FlatPoint[] = []
  for (const s of nonEmpty) {
    const range = s.max - s.min
    const norm = (v: number) => (range > 0 ? (v - s.min) / range : 0.5)
    const label = labels.get(s) ?? s.label
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

  const labelMap = buildLabelMap(nonEmpty)
  const values = flatten(nonEmpty, labelMap)
  const groups = groupByUnits(nonEmpty)
  const groupCount = groups.size
  const durationSec = to - from
  const timeFormat = pickTimeFormat(durationSec)
  const seriesCount = nonEmpty.length

  const xScaleDomain = [new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()]
  const xEnc = {
    field: 't',
    type: 'temporal',
    axis: { title: null, format: timeFormat, labelAngle: -30, labelOverlap: 'parity' },
    scale: { domain: xScaleDomain },
  } as const

  const colorRange = nonEmpty.map((_, i) => PALETTE[i % PALETTE.length] ?? '#000')
  const allLabels = nonEmpty.map(s => labelMap.get(s)!)

  // Legend layout: bottom row(s) for ≤ 3 series, side panel for many series.
  // Both with generous labelLimit so nothing gets the "…" treatment.
  const legendCfg =
    seriesCount <= 1
      ? null
      : seriesCount <= 3
        ? { title: null as null, orient: 'bottom' as const, direction: 'horizontal' as const, columns: 0, labelLimit: 360, symbolSize: 80, padding: 8 }
        : { title: null as null, orient: 'right' as const, direction: 'vertical' as const, columns: 1, labelLimit: 280, symbolSize: 80, rowPadding: 4 }

  const colorEnc = {
    field: 'series',
    type: 'nominal',
    scale: { domain: allLabels, range: colorRange },
    legend: legendCfg,
  } as const

  const baseConfig = {
    view: { stroke: 'transparent' },
    axis: { labelColor: '#64748b', titleColor: '#64748b', gridColor: '#e2e8f0' },
    legend: { labelColor: '#334155', titleColor: '#334155', labelFontSize: 11 },
  } as const

  // Side legends eat horizontal space; widen the canvas to keep the plot area readable
  const width = legendCfg?.orient === 'right' ? 980 : 880

  const baseSpec: Omit<TopLevelSpec, 'data'> = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width,
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
      const grpLabels = grpSeries.map(s => labelMap.get(s)!)
      const filterExpr = grpLabels.map(l => `'${l.replace(/'/g, "\\'")}'`).join(',')
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
    const legendLabels = nonEmpty.map(s => {
      const base = labelMap.get(s)!
      const range = `${s.min.toFixed(2)}…${s.max.toFixed(2)}${s.units ? ` ${s.units}` : ''}`
      return `${base} · ${range}`
    })
    const seriesToLegend = new Map<string, string>()
    nonEmpty.forEach((s, i) => seriesToLegend.set(labelMap.get(s)!, legendLabels[i] ?? ''))
    const normedValues = values.map(p => ({ ...p, seriesLegend: seriesToLegend.get(p.series) ?? p.series }))
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
          legend: legendCfg,
        },
      },
    } as TopLevelSpec
  }

  const compiled = compile(spec).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  return await view.toSVG()
}

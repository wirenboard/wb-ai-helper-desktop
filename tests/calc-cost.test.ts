import { describe, test, expect } from 'bun:test'
import { calcCost, contextWindowOf } from '../src/web/api.ts'

describe('calcCost', () => {
  test('server-reported cost (tokensCost > 0) returns it with provider currency', () => {
    const result = calcCost(100, 50, 0, { provider: 'openai', tokensCost: 0.05 })
    expect(result).toEqual({ value: 0.05, currency: 'USD' })
  })

  test('server-reported cost without provider defaults to RUB', () => {
    const result = calcCost(100, 50, 0, { tokensCost: 1.5 })
    expect(result).toEqual({ value: 1.5, currency: 'RUB' })
  })

  test('custom provider without pricesEditable returns null', () => {
    const result = calcCost(100, 50, 0, { provider: 'custom' })
    expect(result).toBeNull()
  })

  test('custom_proxy provider without prices returns null', () => {
    const result = calcCost(100, 50, 0, { provider: 'custom_proxy' })
    expect(result).toBeNull()
  })

  test('openai with prices computes USD cost', () => {
    const result = calcCost(1_000_000, 500_000, 0, {
      provider: 'openai',
      priceInput: 3, // $3/1M
      priceOutput: 15, // $15/1M
    })
    expect(result).toEqual({ value: 3 + 7.5, currency: 'USD' })
  })

  test('cached tokens use priceCached', () => {
    const result = calcCost(1_000_000, 0, 500_000, {
      provider: 'openai',
      priceInput: 10,
      priceOutput: 0,
      priceCached: 2,
    })
    // input = (1M - 500k) * 10 / 1M = 5
    // cached = 500k * 2 / 1M = 1
    expect(result).toEqual({ value: 6, currency: 'USD' })
  })

  test('priceCached falls back to priceInput when null', () => {
    const result = calcCost(1_000_000, 0, 500_000, {
      provider: 'openai',
      priceInput: 10,
      priceOutput: 0,
      priceCached: null,
    })
    // input = 500k * 10 / 1M = 5
    // cached = 500k * 10 / 1M = 5
    expect(result).toEqual({ value: 10, currency: 'USD' })
  })

  test('no prices returns null', () => {
    const result = calcCost(100, 50, 0, {
      provider: 'openai',
      priceInput: null,
      priceOutput: null,
    })
    expect(result).toBeNull()
  })

  test('zero tokens returns zero cost', () => {
    const result = calcCost(0, 0, 0, {
      provider: 'openai',
      priceInput: 10,
      priceOutput: 30,
    })
    expect(result).toEqual({ value: 0, currency: 'USD' })
  })

  test('tokensCost = 0 is not used (falls through to computed)', () => {
    const result = calcCost(1_000_000, 0, 0, {
      provider: 'openai',
      tokensCost: 0,
      priceInput: 5,
      priceOutput: 0,
    })
    expect(result).toEqual({ value: 5, currency: 'USD' })
  })
})

describe('contextWindowOf', () => {
  test('known model returns its context window', () => {
    expect(contextWindowOf('gpt-4o')).toBeGreaterThan(0)
  })

  test('unknown model returns 128000', () => {
    expect(contextWindowOf('totally-unknown-model')).toBe(128_000)
  })

  test('override > 0 takes precedence', () => {
    expect(contextWindowOf('gpt-4o', 50_000)).toBe(50_000)
  })

  test('override = 0 is ignored', () => {
    expect(contextWindowOf('gpt-4o', 0)).toBeGreaterThan(0)
  })

  test('override = null is ignored', () => {
    expect(contextWindowOf('gpt-4o', null)).toBeGreaterThan(0)
  })

  test('empty string model returns 128000', () => {
    expect(contextWindowOf('')).toBe(128_000)
  })
})

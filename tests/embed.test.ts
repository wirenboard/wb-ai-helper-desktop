import { describe, test, expect } from 'bun:test'
import { mimeFor } from '../src/server/embed.ts'

describe('mimeFor', () => {
  test('.js', () => expect(mimeFor('app.js')).toBe('application/javascript; charset=utf-8'))
  test('.css', () => expect(mimeFor('style.css')).toBe('text/css; charset=utf-8'))
  test('.svg', () => expect(mimeFor('icon.svg')).toBe('image/svg+xml'))
  test('.png', () => expect(mimeFor('logo.png')).toBe('image/png'))
  test('.json', () => expect(mimeFor('data.json')).toBe('application/json'))
  test('.woff2', () => expect(mimeFor('font.woff2')).toBe('font/woff2'))
  test('.html', () => expect(mimeFor('index.html')).toBe('text/html; charset=utf-8'))
  test('.ico', () => expect(mimeFor('favicon.ico')).toBe('image/x-icon'))
  test('unknown → octet-stream', () => expect(mimeFor('file.xyz')).toBe('application/octet-stream'))
})

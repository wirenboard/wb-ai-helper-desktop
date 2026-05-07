import { describe, expect, it } from 'bun:test'
import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { pack as tarPack } from 'tar-stream'
import { openArchive } from '../src/server/tools.ts'

function tarBufferOf(files: { name: string; content: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack()
    const chunks: Buffer[] = []
    pack.on('data', (c: Buffer) => chunks.push(c))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
    let i = 0
    const next = () => {
      if (i >= files.length) { pack.finalize(); return }
      const f = files[i++]!
      pack.entry({ name: f.name, size: f.content.length }, f.content, (err) => {
        if (err) return reject(err)
        next()
      })
    }
    next()
  })
}

describe('openArchive', () => {
  it('читает zip и возвращает path/size/isDir', async () => {
    const zip = new JSZip()
    zip.file('hello.txt', 'world')
    zip.folder('subdir')!.file('inner.txt', 'привет')
    const buf = Buffer.from(await zip.generateAsync({ type: 'uint8array' }))

    const entries = await openArchive(buf)
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))

    expect(byPath['hello.txt']).toBeDefined()
    expect(byPath['hello.txt']!.isDir).toBe(false)
    expect(byPath['hello.txt']!.size).toBe(5)
    expect((await byPath['hello.txt']!.data()).toString('utf8')).toBe('world')

    expect(byPath['subdir/inner.txt']).toBeDefined()
    expect((await byPath['subdir/inner.txt']!.data()).toString('utf8')).toBe('привет')
  })

  it('читает plain tar', async () => {
    const buf = await tarBufferOf([
      { name: 'a.txt', content: Buffer.from('aaa') },
      { name: 'b.txt', content: Buffer.from('bbb') },
    ])

    const entries = await openArchive(buf)
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))

    expect(byPath['a.txt']).toBeDefined()
    expect(byPath['b.txt']).toBeDefined()
    expect((await byPath['a.txt']!.data()).toString('utf8')).toBe('aaa')
    expect((await byPath['b.txt']!.data()).toString('utf8')).toBe('bbb')
  })

  it('читает tar.gz (gzip + tar magic-bytes)', async () => {
    const tarBuf = await tarBufferOf([
      { name: 'config.json', content: Buffer.from('{"k":1}') },
    ])
    const gz = Buffer.from(gzipSync(tarBuf))

    // gzip magic — 1f 8b
    expect(gz[0]).toBe(0x1f)
    expect(gz[1]).toBe(0x8b)

    const entries = await openArchive(gz)
    expect(entries.find((e) => e.path === 'config.json')).toBeDefined()
    const data = await entries.find((e) => e.path === 'config.json')!.data()
    expect(data.toString('utf8')).toBe('{"k":1}')
  })

  it('бросает понятную ошибку на не-архив', async () => {
    const garbage = Buffer.from('это просто текст а не архив')
    let err: unknown
    try {
      await openArchive(garbage)
    } catch (e) { err = e }
    expect(err).toBeDefined()
  })
})

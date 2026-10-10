import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DAY_MS, dailyFile, dailyFiles, dayOf } from './daily.ts'

test('the day is the UTC date of the time', () => {
  assert.equal(dayOf(Date.parse('2026-09-28T23:59:59.999Z')), '2026-09-28')
  assert.equal(dayOf(Date.parse('2026-09-29T00:00:00.000Z')), '2026-09-29')
  // Local midnight elsewhere does not move it.
  assert.equal(dayOf(Date.parse('2026-09-29T01:30:00.000+03:00')), '2026-09-28')
  assert.equal(dailyFile('/data', 'hot', Date.parse('2026-01-02T12:00:00Z')), join('/data', 'hot-2026-01-02.csv'))
  assert.equal(DAY_MS, 86_400_000)
})

test('only the four daily names with a real date, oldest day first; no directory, none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-daily-'))
  try {
    const names = [
      'reports-2026-09-28.csv',
      'counts-2026-09-28.csv',
      'peers-2026-09-28.csv',
      'hot-2025-09-01.csv',
      'peers-2025-09-01.csv',
      // Not ours: the legacy files, the key, the history, a bad date, a temp file, another prefix.
      'peers.csv',
      'hot.csv',
      'relay-key.bin',
      'history.json',
      'peers-2026-02-31.csv',
      'peers-2026-9-28.csv',
      'peers-2026-09-28.csv.tmp',
      'notes-2026-09-28.csv',
    ]
    for (const n of names) await writeFile(join(dir, n), '')
    const files = await dailyFiles(dir)
    assert.deepEqual(
      files.map((f) => [f.kind, new Date(f.start).toISOString(), f.path]),
      [
        ['hot', '2025-09-01T00:00:00.000Z', join(dir, 'hot-2025-09-01.csv')],
        ['peers', '2025-09-01T00:00:00.000Z', join(dir, 'peers-2025-09-01.csv')],
        ['counts', '2026-09-28T00:00:00.000Z', join(dir, 'counts-2026-09-28.csv')],
        ['peers', '2026-09-28T00:00:00.000Z', join(dir, 'peers-2026-09-28.csv')],
        ['reports', '2026-09-28T00:00:00.000Z', join(dir, 'reports-2026-09-28.csv')],
      ],
    )
    assert.deepEqual(await dailyFiles(join(dir, 'none')), [])
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'x'), '')
    await assert.rejects(dailyFiles(join(dir, 'sub', 'x')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

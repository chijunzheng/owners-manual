import { describe, expect, it } from 'vitest'

import { extractManifestSnapshot } from './manifest-snapshot-util.js'

const MANIFEST = {
  version: 1,
  sources: [
    { id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27', file: 'x' },
    { id: 'reg-516-06', sha256: 'b'.repeat(64), consolidationDate: '2020-11-30', file: 'y' },
    {
      id: 'rent-increase-guideline',
      sha256: 'c'.repeat(64),
      consolidationDate: '2025-06-01',
      file: 'z',
    },
  ],
}

describe('extractManifestSnapshot', () => {
  it('extracts id, checksum, and consolidation date for the requested sources', () => {
    const snapshot = extractManifestSnapshot(MANIFEST, ['rta-2006', 'reg-516-06'])
    expect(snapshot).toEqual([
      { id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27' },
      { id: 'reg-516-06', sha256: 'b'.repeat(64), consolidationDate: '2020-11-30' },
    ])
  })

  it('never includes a source it was not asked for (excludes rent-increase-guideline)', () => {
    const snapshot = extractManifestSnapshot(MANIFEST, ['rta-2006', 'reg-516-06'])
    expect(snapshot.map((s) => s.id)).not.toContain('rent-increase-guideline')
  })

  it('throws when a requested source is absent from the manifest', () => {
    expect(() => extractManifestSnapshot(MANIFEST, ['missing'])).toThrow(/missing/)
  })
})

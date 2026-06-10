import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME, scaffoldReady } from './index.js'

describe('@owners-manual/core scaffold', () => {
  it('exposes the package name', () => {
    expect(PACKAGE_NAME).toBe('@owners-manual/core')
  })

  it('reports the scaffold is wired', () => {
    expect(scaffoldReady()).toBe(true)
  })
})

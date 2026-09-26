// Shim so @nestjs/axios spec files (`import { describe, it, expect, ... } from 'vitest'`)
// run unmodified under this repo's Jest. Jest exposes the same names as
// globals; the matcher surface the specs use (toBe/toEqual/toMatchObject/
// toContain/toHaveLength/toBeInstanceOf/rejects/not, etc.) is common to both
// runners, so no translation layer is needed beyond re-exporting the globals.
module.exports = {
  describe: global.describe,
  it: global.it,
  test: global.test,
  expect: global.expect,
  beforeAll: global.beforeAll,
  afterAll: global.afterAll,
  beforeEach: global.beforeEach,
  afterEach: global.afterEach,
  vi: global.jest,
};

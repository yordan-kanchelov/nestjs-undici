import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIBRARY_VERSION } from '../version';

describe('LIBRARY_VERSION', () => {
  it("matches package.json's version", () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };

    expect(LIBRARY_VERSION).toBe(packageJson.version);
  });
});

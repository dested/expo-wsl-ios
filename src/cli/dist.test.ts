// dist/cli.js is committed: installs come straight from GitHub, with no build step. It must match the source.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

test('dist/cli.js is built from the current source (run `bun run build`)', async () => {
  const out = await Bun.build({ entrypoints: [join(root, 'src/cli/index.ts')], root, target: 'node', packages: 'external' });
  const [built] = out.outputs;
  expect(built).toBeDefined();
  expect(await built?.text()).toBe(await Bun.file(join(root, 'dist/cli.js')).text());
});

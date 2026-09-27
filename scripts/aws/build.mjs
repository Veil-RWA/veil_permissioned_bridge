// Bundles the relayer's Lambda handler into one self-contained file, as the
// HyperVeil keeper does: starknet.js, ethers and the AWS SDK are bundled, not
// zipped as node_modules and not left to whatever SDK the runtime ships.

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(here, 'tick.js')],
  outfile: join(out, 'tick.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
});

console.log(`bundled into ${out}`);

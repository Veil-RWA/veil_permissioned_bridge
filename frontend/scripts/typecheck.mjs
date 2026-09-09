// Typecheck src/, ignoring diagnostics from inside node_modules.
//
// starknet.js pulls in abi-wan-kanabi, which ships raw .ts rather than
// declarations, so `noUnusedLocals` fires on THEIR unused locals. skipLibCheck
// does not help -- it only skips .d.ts. Rather than turn the check off for our
// own code (it already caught one dead helper), the third-party lines are
// filtered here and only src/ errors fail the build.
import { spawnSync } from 'node:child_process';

const tsc = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  { encoding: 'utf8' }
);

const lines = `${tsc.stdout || ''}${tsc.stderr || ''}`.split('\n').filter(Boolean);
const ours = lines.filter((l) => !l.startsWith('node_modules/') && !l.includes('/node_modules/'));

if (ours.length) {
  console.error(ours.join('\n'));
  console.error(`\n${ours.length} error(s) in src/`);
  process.exit(1);
}

const skipped = lines.length - ours.length;
console.log(`typecheck clean${skipped ? ` (${skipped} third-party diagnostics ignored)` : ''}`);

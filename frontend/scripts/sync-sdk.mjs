// Refresh the vendored SDK from the repository's sdk/ package.
//
// The bridge is deployed on its own, so it cannot depend on a sibling folder
// outside it. The compiled SDK is vendored into vendor/veil-sdk; this keeps
// that copy honest. With --if-present it is a no-op when sdk/ is absent, which
// is the case for anyone who cloned only the bridge -- there the committed copy
// is what runs.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, '../../../sdk');
const dest = resolve(here, '../vendor/veil-sdk/dist');
const optional = process.argv.includes('--if-present');

if (!existsSync(sdk)) {
  if (optional) {
    console.log('sync-sdk: sdk/ not present — using the vendored copy');
    process.exit(0);
  }
  console.error(`sync-sdk: ${sdk} not found`);
  process.exit(1);
}

try {
  execSync('npm run build', { cwd: sdk, stdio: 'inherit' });
} catch {
  console.log('sync-sdk: sdk build failed — keeping the vendored copy');
  process.exit(optional ? 0 : 1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(resolve(sdk, 'dist'), dest, { recursive: true });
console.log('sync-sdk: vendored copy refreshed');

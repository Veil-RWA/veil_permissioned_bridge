// Copy the active deployment into src/deployment.json so the app has real
// addresses without hardcoding them. Mirrors the pattern the other Veil apps
// use: deployments are produced by the scripts, never edited by hand here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const deployments = path.join(here, '..', '..', 'deployments');
const out = path.join(here, '..', 'src', 'deployment.json');

const wanted = process.env.VITE_DEPLOYMENT ||
  'ethereum-sepolia__starknet-sepolia.json';
const file = path.join(deployments, wanted);

if (!fs.existsSync(file)) {
  // Not an error: the app renders a "not deployed" state rather than failing to
  // build, so the UI can be worked on before anything is on chain.
  fs.writeFileSync(out, JSON.stringify({ missing: true, wanted }, null, 2) + '\n');
  console.log(`pull-deployment: ${wanted} not found, wrote a placeholder`);
} else {
  fs.copyFileSync(file, out);
  console.log(`pull-deployment: ${wanted}`);
}

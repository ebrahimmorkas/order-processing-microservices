// Bundles each service (plus the shared @ops/common source) into a single ESM
// file: dist/<service>/main.js. Third-party packages stay external and are
// installed in the runtime image.
import { build } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});
const requested = process.argv.slice(2);
const services = requested.length
  ? requested
  : readdirSync('services', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

for (const service of services) {
  await build({
    entryPoints: [`services/${service}/src/main.ts`],
    outfile: `dist/${service}/main.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    external,
    logLevel: 'warning',
  });
  console.log(`built ${service}`);
}

// Builds the Windows app from WSL. By default the app starts its backend inside WSL (config.json below). It also
// carries a copy of the backend and its runtime packages in resources/native, for people who pick native Windows.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = realpathSync(process.execPath);
const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
const home = process.env.HOME;
writeFileSync(resolve(root, 'app/config.json'), JSON.stringify({
  distro: process.env.WSL_DISTRO_NAME,
  node,
  backend: resolve(root, 'backend/server.js'),
  path: `${dirname(node)}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  runtime: `/run/user/${uid}`,
  sock: `/run/user/${uid}/cowork.sock`,
}, null, 2));
const [out] = await packager({ dir: resolve(root, 'app'), out: resolve(root, 'dist'), name: 'terminal-cowork', platform: 'win32', arch: 'x64', overwrite: true, asar: false, icon: resolve(root, 'app/icon.ico'), electronVersion: JSON.parse(execFileSync('npm', ['pkg', 'get', 'version'], { cwd: resolve(root, 'node_modules/electron'), encoding: 'utf8' })) });

// Native Windows backend: the code it runs plus the packages it imports, with their dependencies. node-pty ships
// prebuilt win32 binaries and uses N-API, so it loads under the app's own binary running as Node.
const native = join(out, 'resources', 'native');
for (const dir of ['backend', 'src', 'skills']) cpSync(resolve(root, dir), join(native, dir), { recursive: true });
cpSync(resolve(root, 'package.json'), join(native, 'package.json'));
const seen = new Set();
const copyPackage = (name, from) => {
  const dir = [join(from, 'node_modules', name), join(root, 'node_modules', name)].find((d) => existsSync(join(d, 'package.json')));
  if (!dir || seen.has(dir)) return;
  seen.add(dir);
  const target = join(native, 'node_modules', dir.slice(join(root, 'node_modules').length + 1));
  cpSync(dir, target, { recursive: true, filter: (f) => !/[\\/]prebuilds[\\/]darwin-/.test(f) });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, dir);
};
for (const name of ['node-pty', 'marked', '@modelcontextprotocol/sdk', 'zod']) copyPackage(name, root);
console.log(out);

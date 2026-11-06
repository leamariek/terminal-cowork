// Builds the Windows app from WSL. The app itself holds no terminal code: it starts the backend inside WSL.
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { packager } from '@electron/packager';

const root = resolve(new URL('..', import.meta.url).pathname);
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
const [out] = await packager({ dir: resolve(root, 'app'), out: resolve(root, 'dist'), name: 'Cowork', platform: 'win32', arch: 'x64', overwrite: true, asar: false, icon: resolve(root, 'app/icon.ico'), electronVersion: JSON.parse(execFileSync('npm', ['pkg', 'get', 'version'], { cwd: resolve(root, 'node_modules/electron'), encoding: 'utf8' })) });
console.log(out);

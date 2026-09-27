#!/usr/bin/env node
// Builds everything the Tauri shell needs:
//   apps/desktop/src-tauri/binaries/orc-node-<triple>   the Node runtime, used as the sidecar binary
//   apps/desktop/src-tauri/resources/daemon/            the daemon bundle + production node_modules (native addons)
//   apps/desktop/src-tauri/resources/web/               the built web app
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tauriDir = join(root, 'apps/desktop/src-tauri');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

/** The Rust host target triple, which Tauri appends to the sidecar binary's file name. */
function hostTriple() {
  let out;
  try {
    out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(
        'build-sidecar: `rustc` was not found on PATH. The sidecar binary name needs the Rust host target ' +
          'triple. Install Rust (https://rustup.rs) and run this script again.',
      );
      process.exit(1);
    }
    throw err;
  }
  const host = /^host:\s*(\S+)$/m.exec(out)?.[1];
  if (!host) {
    console.error(`build-sidecar: could not read the host triple from \`rustc -vV\`:\n${out}`);
    process.exit(1);
  }
  return host;
}

const triple = hostTriple();
console.log(`target triple: ${triple}`);

// 1. the Node runtime becomes the sidecar binary
const binaries = join(tauriDir, 'binaries');
mkdirSync(binaries, { recursive: true });
const nodeTarget = join(binaries, `orc-node-${triple}`);
copyFileSync(process.execPath, nodeTarget);
chmodSync(nodeTarget, 0o755);
console.log(`sidecar: ${nodeTarget} (node ${process.version})`);

// 2. daemon bundle + production dependencies (native addons match this Node)
run('pnpm', ['--filter', '@orc/daemon', 'build']);
const daemonOut = join(tauriDir, 'resources/daemon');
rmSync(daemonOut, { recursive: true, force: true });
run('pnpm', ['--filter', '@orc/daemon', 'deploy', '--prod', '--legacy', daemonOut]);

// 3. the web app
run('pnpm', ['--filter', '@orc/web', 'build']);
const webOut = join(tauriDir, 'resources/web');
rmSync(webOut, { recursive: true, force: true });
cpSync(join(root, 'apps/web/dist'), webOut, { recursive: true });

console.log('sidecar assets ready');

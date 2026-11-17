import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

export function mockPrivateFixtureModes(paths) {
  if (process.platform !== 'win32') return () => {};

  // Windows stat cannot represent mode 0600. Emulate it for these synthetic files only.
  const fixtures = new Set(paths);
  const originalStat = fs.statSync;
  fs.statSync = (path, options) => {
    const stat = originalStat(path, options);
    if (fixtures.has(path) && stat?.isFile()) stat.mode = (stat.mode & ~0o777) | 0o600;
    return stat;
  };
  syncBuiltinESMExports();

  return () => {
    fs.statSync = originalStat;
    syncBuiltinESMExports();
  };
}

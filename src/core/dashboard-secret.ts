/** Single source for the machine-local dashboard/daemon HMAC key path. */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function dashboardSecretPath(homeDir = homedir()): string {
  const stateDir = process.env.SESSION_DATA_DIR?.trim();
  if (
    stateDir &&
    process.env.BOTMUX_PRESERVE_HOST_PATHS === '1'
  ) {
    return join(stateDir, '.dashboard-secret');
  }
  return join(homeDir, '.botmux', '.dashboard-secret');
}

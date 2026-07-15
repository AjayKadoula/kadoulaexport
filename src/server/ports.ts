/**
 * Find an available TCP port, scanning upward from a base. Used by the headless
 * web-UI server so it never collides with something already running.
 */

import { createServer } from 'node:net';

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export async function findAvailablePort(base = 4173, attempts = 50, host = '127.0.0.1'): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = base + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`no free port found in range ${base}..${base + attempts}`);
}

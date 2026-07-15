/**
 * Choose the best available storage driver. SQLite (WAL, crash-safe, scalable
 * history) is strongly preferred; the JSON driver is a safe fallback when the
 * native module is unavailable, so the app always starts.
 */

import { Storage } from './types';
import { JsonStorage } from './jsonStore';

export interface StorageChoice {
  storage: Storage;
  driver: 'sqlite' | 'json';
  reason?: string;
}

export function createStorage(opts: { sqlitePath: string; jsonPath: string }): StorageChoice {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SqliteStorage } = require('./sqlite') as typeof import('./sqlite');
    const storage = new SqliteStorage(opts.sqlitePath);
    storage.init();
    return { storage, driver: 'sqlite' };
  } catch (err) {
    const storage = new JsonStorage(opts.jsonPath);
    storage.init();
    return {
      storage,
      driver: 'json',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

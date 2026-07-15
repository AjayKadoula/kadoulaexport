/**
 * Session manager (pure core). Tracks per-platform session state (guest vs
 * authenticated, healthy vs expired), decides when to notify the user to
 * re-login, and coordinates the re-login workflow. The actual login *window*
 * and cookie persistence are provided by an injected `LoginPortal` (Electron
 * implements it with a visible BrowserWindow; tests inject a fake). The manager
 * never sees or stores credentials — only whether a session is healthy.
 */

import { PlatformId, SessionProbe } from '../core/types';

export type SessionMode = 'guest' | 'authenticated';
export type SessionStatus = 'healthy' | 'expired' | 'unknown';

export interface PlatformSession {
  platform: PlatformId;
  mode: SessionMode;
  status: SessionStatus;
  lastCheckedAt: number;
  /** True once the user has been notified about an expiry (dedupe notices). */
  expiryNotified: boolean;
}

export interface LoginPortal {
  /** Open a visible login window; resolves when the user finishes (or cancels). */
  openLogin(platform: PlatformId): Promise<{ success: boolean }>;
  /** Cheap check that the persisted session is still valid. */
  probe(platform: PlatformId): Promise<SessionProbe>;
}

export interface SessionEvents {
  onExpired?(platform: PlatformId): void;
  onRecovered?(platform: PlatformId): void;
}

export class SessionManager {
  private readonly sessions = new Map<PlatformId, PlatformSession>();

  constructor(
    private readonly portal: LoginPortal,
    private readonly now: () => number,
    private readonly events: SessionEvents = {},
  ) {}

  get(platform: PlatformId): PlatformSession {
    let s = this.sessions.get(platform);
    if (!s) {
      s = { platform, mode: 'guest', status: 'unknown', lastCheckedAt: 0, expiryNotified: false };
      this.sessions.set(platform, s);
    }
    return s;
  }

  list(): PlatformSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Called when an adapter reports a login-wall/auth failure. Confirms via a
   * session probe (so a single odd response doesn't trigger a false expiry),
   * and notifies the user exactly once per expiry episode.
   */
  async reportAuthFailure(platform: PlatformId): Promise<void> {
    const probe = await this.portal.probe(platform);
    const s = this.get(platform);
    s.lastCheckedAt = this.now();
    if (probe.loggedIn && probe.healthy) {
      // False alarm — session is actually fine.
      if (s.status === 'expired') this.markRecovered(platform);
      s.status = 'healthy';
      s.mode = 'authenticated';
      return;
    }
    if (s.status !== 'expired') {
      s.status = 'expired';
      if (!s.expiryNotified) {
        s.expiryNotified = true;
        this.events.onExpired?.(platform);
      }
    }
  }

  /** Drive the re-login flow (opens the login window via the portal). */
  async relogin(platform: PlatformId): Promise<boolean> {
    const { success } = await this.portal.openLogin(platform);
    if (!success) return false;
    const probe = await this.portal.probe(platform);
    const s = this.get(platform);
    s.lastCheckedAt = this.now();
    if (probe.loggedIn && probe.healthy) {
      s.mode = 'authenticated';
      this.markRecovered(platform);
      return true;
    }
    return false;
  }

  /** Periodic heartbeat: refresh status for a platform. */
  async heartbeat(platform: PlatformId): Promise<SessionStatus> {
    const probe = await this.portal.probe(platform);
    const s = this.get(platform);
    s.lastCheckedAt = this.now();
    if (probe.healthy && (probe.loggedIn || s.mode === 'guest')) {
      if (s.status === 'expired') this.markRecovered(platform);
      s.status = 'healthy';
    } else if (!probe.loggedIn && s.mode === 'authenticated') {
      if (s.status !== 'expired') {
        s.status = 'expired';
        if (!s.expiryNotified) {
          s.expiryNotified = true;
          this.events.onExpired?.(platform);
        }
      }
    }
    return s.status;
  }

  private markRecovered(platform: PlatformId): void {
    const s = this.get(platform);
    s.status = 'healthy';
    s.expiryNotified = false;
    this.events.onRecovered?.(platform);
  }
}

import { describe, it, expect } from 'vitest';
import { SessionManager, LoginPortal } from '../src/session/sessionManager';
import { SessionProbe } from '../src/core/types';

class FakePortal implements LoginPortal {
  probeResult: SessionProbe = { loggedIn: false, locationApplied: true, healthy: true };
  loginSucceeds = true;
  openCount = 0;
  async openLogin(): Promise<{ success: boolean }> {
    this.openCount++;
    return { success: this.loginSucceeds };
  }
  async probe(): Promise<SessionProbe> {
    return this.probeResult;
  }
}

describe('session manager', () => {
  it('notifies once on confirmed expiry, not on every failure', async () => {
    const portal = new FakePortal();
    portal.probeResult = { loggedIn: false, locationApplied: true, healthy: false };
    let expired = 0;
    const sm = new SessionManager(portal, () => 1000, { onExpired: () => expired++ });
    // authenticated -> then expires
    sm.get('zepto').mode = 'authenticated';
    await sm.reportAuthFailure('zepto');
    await sm.reportAuthFailure('zepto');
    await sm.reportAuthFailure('zepto');
    expect(expired).toBe(1);
    expect(sm.get('zepto').status).toBe('expired');
  });

  it('treats a probe-confirmed healthy session as a false alarm', async () => {
    const portal = new FakePortal();
    portal.probeResult = { loggedIn: true, locationApplied: true, healthy: true };
    let expired = 0;
    const sm = new SessionManager(portal, () => 1, { onExpired: () => expired++ });
    sm.get('amazon').mode = 'authenticated';
    await sm.reportAuthFailure('amazon');
    expect(expired).toBe(0);
    expect(sm.get('amazon').status).toBe('healthy');
  });

  it('re-login flow recovers the session and re-arms notifications', async () => {
    const portal = new FakePortal();
    portal.probeResult = { loggedIn: false, locationApplied: true, healthy: false };
    let expired = 0;
    let recovered = 0;
    const sm = new SessionManager(portal, () => 1, {
      onExpired: () => expired++,
      onRecovered: () => recovered++,
    });
    sm.get('zepto').mode = 'authenticated';
    await sm.reportAuthFailure('zepto');
    expect(expired).toBe(1);

    // user logs in; probe now healthy
    portal.probeResult = { loggedIn: true, locationApplied: true, healthy: true };
    const ok = await sm.relogin('zepto');
    expect(ok).toBe(true);
    expect(recovered).toBe(1);
    expect(sm.get('zepto').status).toBe('healthy');
    expect(sm.get('zepto').expiryNotified).toBe(false); // re-armed

    // a subsequent expiry can notify again
    portal.probeResult = { loggedIn: false, locationApplied: true, healthy: false };
    await sm.reportAuthFailure('zepto');
    expect(expired).toBe(2);
  });

  it('guest platforms stay healthy on heartbeat', async () => {
    const portal = new FakePortal();
    portal.probeResult = { loggedIn: false, locationApplied: true, healthy: true };
    const sm = new SessionManager(portal, () => 1);
    const status = await sm.heartbeat('blinkit');
    expect(status).toBe('healthy');
  });
});

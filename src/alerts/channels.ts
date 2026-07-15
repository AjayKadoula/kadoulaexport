/**
 * Alert channels. Each formats the alert and delivers via one medium. They are
 * written to degrade gracefully: if the underlying runtime (Electron
 * Notification, a mail transport, network) is unavailable, the channel throws a
 * descriptive error which the dispatcher records and retries — it never crashes
 * the engine.
 *
 * Message content always includes the full required alert payload
 * (product, platform, location, price, timestamp, state, link, confidence).
 */

import { Alert, AlertChannel, formatMoney } from '../core/types';

export function formatAlertText(a: Alert): string {
  const lines = [
    `${stateEmoji(a.state)} ${a.productName} — ${a.state}`,
    `Platform: ${a.platformId}   Pincode: ${a.pincode}`,
    `Price: ${formatMoney(a.price)}   Confidence: ${a.confidenceLevel} (${(a.confidence * 100).toFixed(0)}%)`,
    `When: ${new Date(a.at).toISOString()}`,
  ];
  if (a.url) lines.push(`Link: ${a.url}`);
  return lines.join('\n');
}

export function formatAlertTitle(a: Alert): string {
  return `${a.productName} is ${humanState(a.state)} on ${a.platformId} (${a.pincode})`;
}

function humanState(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase();
}

function stateEmoji(s: string): string {
  switch (s) {
    case 'AVAILABLE': return '🟢';
    case 'PREORDER': return '🟦';
    case 'COMING_SOON': return '🔵';
    default: return '🔔';
  }
}

// ---------------------------------------------------------------------------
// Desktop notification (Electron). Optional injection keeps core testable.
// ---------------------------------------------------------------------------

export interface DesktopNotifier {
  notify(title: string, body: string, onClick?: () => void): void;
}

export class DesktopChannel implements AlertChannel {
  readonly name = 'desktop' as const;
  constructor(
    readonly enabled: boolean,
    private readonly notifier: DesktopNotifier,
    private readonly onOpen?: (url: string) => void,
  ) {}

  async send(alert: Alert): Promise<void> {
    this.notifier.notify(formatAlertTitle(alert), formatAlertText(alert), () => {
      if (alert.url && this.onOpen) this.onOpen(alert.url);
    });
  }
}

// ---------------------------------------------------------------------------
// Sound alert.
// ---------------------------------------------------------------------------

export interface SoundPlayer {
  play(soundId: string): void;
}

export class SoundChannel implements AlertChannel {
  readonly name = 'sound' as const;
  constructor(
    readonly enabled: boolean,
    private readonly player: SoundPlayer,
    private readonly soundId = 'default',
  ) {}

  async send(_alert: Alert): Promise<void> {
    this.player.play(this.soundId);
  }
}

// ---------------------------------------------------------------------------
// Email (SMTP). The transport is injected so we don't hard-depend on nodemailer;
// the Electron host wires a real transport, tests inject a fake.
// ---------------------------------------------------------------------------

export interface MailTransport {
  sendMail(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export class EmailChannel implements AlertChannel {
  readonly name = 'email' as const;
  constructor(
    readonly enabled: boolean,
    private readonly transport: MailTransport,
    private readonly to: string,
  ) {}

  async send(alert: Alert): Promise<void> {
    if (!this.to) throw new Error('email recipient not configured');
    await this.transport.sendMail({
      to: this.to,
      subject: formatAlertTitle(alert),
      text: formatAlertText(alert),
    });
  }
}

// ---------------------------------------------------------------------------
// WhatsApp via a user-configured HTTP gateway (e.g. CallMeBot or a Twilio proxy
// the user sets up). We only POST to a URL the user supplies; no credentials are
// embedded. The fetch impl is injected for testability.
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface WhatsAppConfig {
  /** Gateway endpoint template; {message} is URL-encoded and substituted. */
  gatewayUrl: string;
  method?: 'GET' | 'POST';
}

export class WhatsAppChannel implements AlertChannel {
  readonly name = 'whatsapp' as const;
  constructor(
    readonly enabled: boolean,
    private readonly cfg: WhatsAppConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  async send(alert: Alert): Promise<void> {
    if (!this.cfg.gatewayUrl) throw new Error('whatsapp gateway not configured');
    const message = `${formatAlertTitle(alert)}\n${formatAlertText(alert)}`;
    const url = this.cfg.gatewayUrl.replace('{message}', encodeURIComponent(message));
    const method = this.cfg.method ?? 'GET';
    const res = await this.fetchImpl(url, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify({ message }) : undefined,
    });
    if (!res.ok) {
      throw new Error(`whatsapp gateway returned HTTP ${res.status}: ${await res.text()}`);
    }
  }
}

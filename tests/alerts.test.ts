import { describe, it, expect } from 'vitest';
import { Dispatcher } from '../src/alerts/dispatcher';
import {
  DesktopChannel,
  EmailChannel,
  WhatsAppChannel,
  SoundChannel,
  formatAlertText,
  FetchLike,
  MailTransport,
  DesktopNotifier,
  SoundPlayer,
} from '../src/alerts/channels';
import { Alert, AvailabilityState, inr } from '../src/core/types';
import { FakeClock, FakeChannel, silentLogger } from './helpers/fakes';

function sampleAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'al1',
    transitionId: 'tr1',
    targetId: 't1',
    at: Date.UTC(2026, 6, 15, 9, 30),
    productName: 'iPhone 17 Pro Max',
    platformId: 'amazon',
    pincode: '122001',
    state: AvailabilityState.AVAILABLE,
    reason: 'restock',
    price: inr(134900),
    url: 'https://www.amazon.in/dp/XYZ',
    confidence: 0.95,
    confidenceLevel: 'high',
    ...over,
  };
}

describe('alert payload completeness', () => {
  it('formatted alert includes every required field', () => {
    const text = formatAlertText(sampleAlert());
    expect(text).toContain('iPhone 17 Pro Max');
    expect(text).toContain('AVAILABLE');
    expect(text).toContain('amazon');
    expect(text).toContain('122001');
    expect(text).toContain('₹1,34,900');
    expect(text).toContain('high');
    expect(text).toContain('amazon.in/dp/XYZ');
    expect(text).toContain('2026-07-15');
  });
});

describe('dispatcher — channel isolation & retry', () => {
  it('one failing channel does not block others', async () => {
    const clock = new FakeClock();
    const ok = new FakeChannel('desktop');
    const bad = new FakeChannel('email');
    bad.failTimes = 99; // always fails
    const dispatcher = new Dispatcher({ channels: [ok, bad], clock, logger: silentLogger(), maxAttempts: 2 });
    const p = dispatcher.dispatch(sampleAlert());
    await clock.advance(10_000); // let retry backoff elapse
    const outcomes = await p;
    const byCh = Object.fromEntries(outcomes.map((o) => [o.channel, o.status]));
    expect(byCh.desktop).toBe('sent');
    expect(byCh.email).toBe('failed');
    expect(ok.received).toHaveLength(1);
  });

  it('retries a flaky channel and eventually succeeds', async () => {
    const clock = new FakeClock();
    const flaky = new FakeChannel('whatsapp');
    flaky.failTimes = 2; // fails twice then succeeds
    const dispatcher = new Dispatcher({ channels: [flaky], clock, logger: silentLogger(), maxAttempts: 3 });
    const p = dispatcher.dispatch(sampleAlert());
    await clock.advance(10_000);
    const [outcome] = await p;
    expect(outcome!.status).toBe('sent');
    expect(outcome!.attempts).toBe(3);
  });

  it('disabled channels are skipped', async () => {
    const clock = new FakeClock();
    const off = new FakeChannel('sound', false);
    const dispatcher = new Dispatcher({ channels: [off], clock, logger: silentLogger() });
    const [outcome] = await dispatcher.dispatch(sampleAlert());
    expect(outcome!.status).toBe('skipped');
  });
});

describe('dispatcher — quiet hours', () => {
  it('suppresses desktop/sound during quiet hours but lets email bypass', async () => {
    const clock = new FakeClock();
    const desktop = new FakeChannel('desktop');
    const email = new FakeChannel('email');
    const dispatcher = new Dispatcher({
      channels: [desktop, email],
      clock,
      logger: silentLogger(),
      quietHours: { enabled: true, startHour: 22, endHour: 8, ignoreChannels: ['email'] },
      localHour: () => 2, // 2am -> within 22..8
    });
    const outcomes = await dispatcher.dispatch(sampleAlert());
    const byCh = Object.fromEntries(outcomes.map((o) => [o.channel, o.status]));
    expect(byCh.desktop).toBe('skipped');
    expect(byCh.email).toBe('sent');
  });
});

describe('concrete channels', () => {
  it('desktop channel calls the notifier', async () => {
    let notified = '';
    const notifier: DesktopNotifier = { notify: (title) => { notified = title; } };
    const ch = new DesktopChannel(true, notifier);
    await ch.send(sampleAlert());
    expect(notified).toContain('iPhone 17 Pro Max');
  });

  it('sound channel plays', async () => {
    let played = '';
    const player: SoundPlayer = { play: (id) => { played = id; } };
    const ch = new SoundChannel(true, player, 'chime');
    await ch.send(sampleAlert());
    expect(played).toBe('chime');
  });

  it('email channel sends via transport', async () => {
    const sent: any[] = [];
    const transport: MailTransport = { sendMail: async (m) => { sent.push(m); } };
    const ch = new EmailChannel(true, transport, 'me@example.com');
    await ch.send(sampleAlert());
    expect(sent[0].to).toBe('me@example.com');
    expect(sent[0].subject).toContain('iPhone 17 Pro Max');
  });

  it('email channel throws when recipient missing (dispatcher will record failure)', async () => {
    const transport: MailTransport = { sendMail: async () => {} };
    const ch = new EmailChannel(true, transport, '');
    await expect(ch.send(sampleAlert())).rejects.toThrow(/recipient/);
  });

  it('whatsapp channel posts to the gateway and errors on non-2xx', async () => {
    const calls: string[] = [];
    const okFetch: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const ch = new WhatsAppChannel(true, { gatewayUrl: 'https://gw/send?text={message}' }, okFetch);
    await ch.send(sampleAlert());
    expect(calls[0]).toContain('https://gw/send?text=');
    expect(calls[0]).toContain('iPhone');

    const badFetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const ch2 = new WhatsAppChannel(true, { gatewayUrl: 'https://gw/send?text={message}' }, badFetch);
    await expect(ch2.send(sampleAlert())).rejects.toThrow(/HTTP 500/);
  });
});

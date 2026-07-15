/**
 * Alert dispatcher. Sends an alert to every enabled channel independently, so
 * one channel failing never blocks another (FR-AL5). Each channel is retried
 * with bounded exponential backoff. Returns per-channel delivery outcomes,
 * which the engine persists alongside the alert.
 *
 * Quiet hours: desktop/sound are suppressed during quiet hours (still recorded
 * as 'skipped'); email/whatsapp can be configured to ignore quiet hours.
 */

import { Alert, AlertChannel, Clock, DeliveryOutcome, Logger } from '../core/types';
import { AlertDispatcher } from '../core/engine';

export interface QuietHours {
  enabled: boolean;
  /** Local hour [0..24) start and end; wraps past midnight if start > end. */
  startHour: number;
  endHour: number;
  /** Channels that ignore quiet hours (still deliver). */
  ignoreChannels: AlertChannel['name'][];
}

export interface DispatcherOptions {
  channels: AlertChannel[];
  clock: Clock;
  logger: Logger;
  maxAttempts?: number;
  quietHours?: QuietHours;
  /** For deterministic tests: returns local hour for a timestamp. */
  localHour?: (at: number) => number;
}

export class Dispatcher implements AlertDispatcher {
  private readonly maxAttempts: number;

  constructor(private readonly opts: DispatcherOptions) {
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  async dispatch(alert: Alert): Promise<DeliveryOutcome[]> {
    const results = await Promise.all(
      this.opts.channels.map((ch) => this.deliverToChannel(ch, alert)),
    );
    return results;
  }

  private inQuietHours(at: number): boolean {
    const q = this.opts.quietHours;
    if (!q?.enabled) return false;
    const hour = this.opts.localHour ? this.opts.localHour(at) : new Date(at).getHours();
    if (q.startHour === q.endHour) return false;
    if (q.startHour < q.endHour) return hour >= q.startHour && hour < q.endHour;
    // wraps midnight
    return hour >= q.startHour || hour < q.endHour;
  }

  private async deliverToChannel(ch: AlertChannel, alert: Alert): Promise<DeliveryOutcome> {
    if (!ch.enabled) {
      return { channel: ch.name, status: 'skipped', attempts: 0, at: alert.at };
    }
    const quiet = this.inQuietHours(alert.at);
    const bypass = this.opts.quietHours?.ignoreChannels.includes(ch.name) ?? false;
    if (quiet && !bypass) {
      this.opts.logger.debug('channel suppressed by quiet hours', { channel: ch.name });
      return { channel: ch.name, status: 'skipped', attempts: 0, at: alert.at };
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ch.send(alert);
        return { channel: ch.name, status: 'sent', attempts: attempt, at: this.opts.clock.now() };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn('channel delivery failed; will retry', {
          channel: ch.name,
          attempt,
          error: lastError,
        });
        if (attempt < this.maxAttempts) {
          // eslint-disable-next-line no-await-in-loop
          await this.opts.clock.sleep(1000 * 2 ** (attempt - 1));
        }
      }
    }
    return {
      channel: ch.name,
      status: 'failed',
      attempts: this.maxAttempts,
      error: lastError,
      at: this.opts.clock.now(),
    };
  }
}

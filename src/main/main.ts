/**
 * Electron main process — the desktop entry point.
 *
 * Design choice: the desktop app and the headless web mode share ONE UI. The
 * main process runs the same WebServer (real engine + Playwright runtime + real
 * alert channels) on a loopback port and loads it in a BrowserWindow. This
 * avoids a second UI codebase and keeps the desktop and headless experiences
 * identical.
 *
 * Electron is an optional dependency; this file is only executed by the
 * packaged desktop build (`npm start`). It is written with a lazy require and
 * minimal typing so the rest of the project builds and tests without Electron
 * installed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { join } from 'node:path';
import { WebServer } from '../server/webServer';
import { PlaywrightRuntime } from '../adapters/playwright/runtime';
import { createStorage } from '../infra/storage/factory';
import { findAvailablePort } from '../server/ports';
import { SystemClock } from '../infra/clock';
import {
  DesktopChannel,
  SoundChannel,
  EmailChannel,
  WhatsAppChannel,
  DesktopNotifier,
  SoundPlayer,
  MailTransport,
} from '../alerts/channels';
import { AlertChannel } from '../core/types';

async function boot(): Promise<void> {
  const electron = require('electron');
  const { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage } = electron;

  await app.whenReady();

  const clock = new SystemClock();
  const userData = app.getPath('userData');
  const { storage } = createStorage({
    sqlitePath: join(userData, 'stock-sentinel.sqlite'),
    jsonPath: join(userData, 'stock-sentinel.json'),
  });
  const runtime = new PlaywrightRuntime({
    userDataRoot: join(userData, 'browser-profiles'),
    now: () => clock.now(),
    headless: true,
  });

  // Real alert channels. Settings-driven config would supply SMTP/WhatsApp; here
  // we wire desktop + sound unconditionally and leave email/whatsapp disabled
  // until the user configures them in Settings.
  const notifier: DesktopNotifier = {
    notify(title, body, onClick) {
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    },
  };
  const player: SoundPlayer = { play: () => shell.beep?.() };
  const channels: AlertChannel[] = [
    new DesktopChannel(true, notifier, (url: string) => shell.openExternal(url)),
    new SoundChannel(true, player),
  ];

  const settings = storage.getSetting<any>('alertChannels');
  if (settings?.email?.enabled && settings.email.to) {
    const transport: MailTransport = {
      async sendMail(msg) {
        // nodemailer is optional; the desktop packager includes it when email is used.
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport(settings.email.smtp);
        await t.sendMail({ from: settings.email.from ?? settings.email.to, ...msg });
      },
    };
    channels.push(new EmailChannel(true, transport, settings.email.to));
  }
  if (settings?.whatsapp?.enabled && settings.whatsapp.gatewayUrl) {
    channels.push(
      new WhatsAppChannel(true, { gatewayUrl: settings.whatsapp.gatewayUrl, method: settings.whatsapp.method }, (url, init) =>
        (globalThis.fetch as any)(url, init),
      ),
    );
  }

  const port = await findAvailablePort(4173);
  const server = new WebServer({ storage, runtime, port, tickIntervalMs: 3000, extraChannels: channels });
  const { url } = await server.start();

  let win: any = null;
  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1200,
      height: 860,
      title: 'Stock Sentinel',
      webPreferences: { contextIsolation: true },
    });
    win.loadURL(url);
    win.on('close', (e: any) => {
      // Closing minimises to tray; monitoring keeps running.
      if (!(app as any).isQuiting) {
        e.preventDefault();
        win.hide();
      }
    });
  };
  createWindow();

  // Tray with engine controls (monitoring continues when the window is hidden).
  let tray: any = null;
  try {
    tray = new Tray(nativeImage.createEmpty());
    const menu = Menu.buildFromTemplate([
      { label: 'Open Stock Sentinel', click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      { label: 'Quit', click: () => { (app as any).isQuiting = true; app.quit(); } },
    ]);
    tray.setToolTip('Stock Sentinel — monitoring');
    tray.setContextMenu(menu);
  } catch {
    /* tray optional */
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
  app.on('before-quit', async () => {
    (app as any).isQuiting = true;
    try {
      await server.stop();
      await runtime.close();
    } catch {
      /* ignore shutdown errors */
    }
  });

  // Launch at login (user-toggleable via Settings later).
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  } catch {
    /* not supported on all platforms */
  }
}

// Only run when actually launched by Electron.
if (require.main !== undefined) {
  boot().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Stock Sentinel failed to start:', err);
    process.exit(1);
  });
}

import fs from 'fs';
import net from 'net';
import tls from 'tls';
import {
  MAIL_CAPTURE_PATH, MAIL_FROM, RESEND_API_KEY, SMTP_FROM, SMTP_HOST, SMTP_IMPLICIT_TLS, SMTP_PASS, SMTP_PORT, SMTP_USER,
  mailConfigured, resendConfigured, smtpConfigured,
} from './env';
import { escapeHtml } from './validate';

export { mailConfigured };

export interface OutboundMail { to: string; subject: string; text: string; html: string }

/** Minimal branded HTML shell. The text part is the source of truth. */
export function brandedHtml(heading: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.45">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;background:#030605;color:#c8ffc8;font-family:ui-monospace,Menlo,Consolas,monospace">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<p style="margin:0 0 8px;color:#39ff14;font-size:13px;letter-spacing:.08em">zeronoise</p>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:650;color:#c8ffc8">${escapeHtml(heading)}</h1>
${body}
</div></body></html>`;
}

/**
 * Send one message. Resend is preferred. SMTP is the fallback.
 * A capture path (tests) records the message and does not open a network connection.
 * Returns false when no sender is configured or the send fails. Never logs the body or secrets.
 */
export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const message: OutboundMail = { to, subject, text, html: html || brandedHtml(subject, [text]) };
  if (MAIL_CAPTURE_PATH) {
    try {
      fs.appendFileSync(MAIL_CAPTURE_PATH, JSON.stringify({ ...message, at: Date.now() }) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      console.warn('[mail] capture failed', (e as Error).message);
      return false;
    }
  }
  if (resendConfigured) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html: message.html }),
      });
      if (!r.ok) {
        console.warn('[mail] resend status', r.status);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[mail] resend', (e as Error).message);
      return false;
    }
  }
  if (smtpConfigured) {
    try {
      await smtpSend(message);
      return true;
    } catch (e) {
      console.warn('[mail] smtp', (e as Error).message);
      return false;
    }
  }
  return false;
}

function dotStuff(body: string): string {
  return body.replace(/^\./gm, '..');
}

function buildData(from: string, message: OutboundMail): string {
  const boundary = `zn${Date.now().toString(16)}`;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(message.html),
    `--${boundary}--`,
    '.',
  ];
  return headers.join('\r\n');
}

type Sock = net.Socket;

function readReply(sock: Sock, buf: { s: string }): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const take = () => {
      const lines: string[] = [];
      let rest = buf.s;
      while (rest.length) {
        const nl = rest.indexOf('\n');
        if (nl < 0) return false;
        const line = rest.slice(0, nl).replace(/\r$/, '');
        rest = rest.slice(nl + 1);
        if (!/^\d{3}[ -]/.test(line)) continue;
        lines.push(line);
        buf.s = rest;
        if (line[3] === ' ') {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), text: lines.join('\n') });
          return true;
        }
      }
      buf.s = rest;
      return false;
    };
    const onData = (chunk: Buffer) => { buf.s += chunk.toString('utf8'); take(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP timeout')); }, 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onErr);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    if (!take()) { /* wait */ }
  });
}

function writeLine(sock: Sock, line: string) {
  sock.write(line + '\r\n');
}

async function expect(sock: Sock, buf: { s: string }, ok: number[]): Promise<{ code: number; text: string }> {
  const reply = await readReply(sock, buf);
  if (!ok.includes(reply.code)) throw new Error(`SMTP ${reply.code}`);
  return reply;
}

function smtpSend(message: OutboundMail): Promise<void> {
  const implicitTls = SMTP_IMPLICIT_TLS;
  const from = SMTP_FROM;
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => { try { sock.destroy(); } catch { /* ignore */ } reject(e); };
    let sock: Sock = implicitTls
      ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
      : net.connect({ host: SMTP_HOST, port: SMTP_PORT });
    const buf = { s: '' };
    const opened = implicitTls ? 'secureConnect' : 'connect';
    sock.once('error', fail);
    sock.once(opened, async () => {
      sock.off('error', fail);
      try {
        await expect(sock, buf, [220]);
        writeLine(sock, 'EHLO camchat');
        let ehlo = await expect(sock, buf, [250]);
        if (!implicitTls && /STARTTLS/i.test(ehlo.text)) {
          writeLine(sock, 'STARTTLS');
          await expect(sock, buf, [220]);
          sock.removeAllListeners('data');
          sock.removeAllListeners('error');
          const plain = sock;
          sock = tls.connect({ socket: plain, servername: SMTP_HOST });
          await new Promise<void>((res, rej) => {
            sock.once('secureConnect', () => res());
            sock.once('error', rej);
          });
          buf.s = '';
          writeLine(sock, 'EHLO camchat');
          ehlo = await expect(sock, buf, [250]);
        }
        if (SMTP_USER) {
          writeLine(sock, 'AUTH LOGIN');
          await expect(sock, buf, [334]);
          writeLine(sock, Buffer.from(SMTP_USER).toString('base64'));
          await expect(sock, buf, [334]);
          writeLine(sock, Buffer.from(SMTP_PASS).toString('base64'));
          await expect(sock, buf, [235]);
        }
        writeLine(sock, `MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '')}>`);
        await expect(sock, buf, [250]);
        writeLine(sock, `RCPT TO:<${message.to}>`);
        await expect(sock, buf, [250, 251]);
        writeLine(sock, 'DATA');
        await expect(sock, buf, [354]);
        sock.write(buildData(from, message) + '\r\n');
        await expect(sock, buf, [250]);
        writeLine(sock, 'QUIT');
        sock.end();
        resolve();
      } catch (e) {
        try { sock.destroy(); } catch { /* ignore */ }
        reject(e instanceof Error ? e : new Error('SMTP failed'));
      }
    });
  });
}

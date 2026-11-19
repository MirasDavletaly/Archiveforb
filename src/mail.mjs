// Minimal SMTP client for one-time codes: TLS from the start (port 465) or STARTTLS (587), AUTH PLAIN,
// a UTF-8 plain-text body. It never sends the password over an unencrypted connection, except to
// localhost (used by the self-check). ponytail: one message per connection; fine for sign-up codes.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const addr = s => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();

export async function sendMail({ host, port, user, pass, from, helo = 'localhost' }, { to, subject, text }) {
  const local = host === '127.0.0.1' || host === 'localhost';
  let buf = '', waiter = null;
  const pump = () => {
    // A reply ends with a line "NNN text"; lines before it read "NNN-text".
    const m = waiter && /(?:^|\r\n)\d{3} [^\r\n]*\r\n/.exec(buf);
    if (!m) return;
    const end = m.index + m[0].length;
    const reply = buf.slice(0, end);
    buf = buf.slice(end);
    const w = waiter;
    waiter = null;
    w.res(reply);
  };
  const onData = d => { buf += d; pump(); };
  const listen = s => {
    s.setEncoding('utf8');
    s.on('data', onData);
    s.on('error', e => waiter?.rej(e));
    s.on('close', () => waiter?.rej(new Error('the mail server closed the connection')));
    s.setTimeout(20000, () => s.destroy(new Error('the mail server did not answer')));
    return s;
  };
  const ready = (s, ev) => new Promise((res, rej) => { s.once(ev, res); s.once('error', rej); });
  const read = () => new Promise((res, rej) => { waiter = { res, rej }; pump(); });
  const cmd = async (line, ok, verb = line?.split(' ')[0]) => {
    if (line != null) sock.write(line + '\r\n');
    const r = await read();
    if (!r.startsWith(ok)) throw new Error(`${verb || 'greeting'}: ${r.trim().split('\r\n').pop()}`); // never echoes credentials
    return r;
  };

  let sock = listen(port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
  try {
    await ready(sock, port === 465 ? 'secureConnect' : 'connect');
    await cmd(null, '220');
    const ehlo = await cmd(`EHLO ${helo}`, '250');
    if (!(sock instanceof tls.TLSSocket)) {
      if (/[\r\n -]STARTTLS\b/i.test(ehlo)) {
        await cmd('STARTTLS', '220');
        sock.removeListener('data', onData);
        sock = listen(tls.connect({ socket: sock, servername: host }));
        await ready(sock, 'secureConnect');
        await cmd(`EHLO ${helo}`, '250');
      } else if (!local) throw new Error('the mail server offers no encryption, so the password is not sent');
    }
    if (user) await cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, '235', 'AUTH');
    await cmd(`MAIL FROM:<${addr(from)}>`, '250');
    await cmd(`RCPT TO:<${to}>`, '25');
    await cmd('DATA', '354');
    const message = [
      `From: ${from}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${addr(from).split('@')[1] || 'localhost'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(text).replace(/.{76}/g, '$&\r\n'),
    ].join('\r\n');
    await cmd(`${message}\r\n.`, '250', 'DATA');
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

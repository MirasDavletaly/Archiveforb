import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8800);
  const publicUrl = new URL(env.PUBLIC_URL || `http://localhost:${port}`);
  const gb = (v, d) => Math.round(Number(v || d) * 2 ** 30);
  // Host headers the server answers to; anything else (DNS rebinding, raw IP:port access) gets 421.
  const host = env.HOST || '127.0.0.1';
  // Where the editor server reaches Files for WOPI calls: on the NAS a private Docker-network address, so documents
  // never leave the machine. WOPI_PORT opens that second listener (WOPI routes only, on the container's own address).
  const wopiUrl = new URL(env.WOPI_URL || publicUrl.origin);
  const allowedHosts = [...new Set([publicUrl.host, wopiUrl.host, `localhost:${port}`, `127.0.0.1:${port}`, `${host}:${port}`, ...(env.ALLOWED_HOSTS || '').split(',')].map(h => h.trim().toLowerCase()).filter(Boolean))];
  return {
    allowedHosts,
    minFree: gb(env.MIN_FREE_GB, 20),
    // Per person (or per external link) and per hour; beyond this, downloads pause and Managers see an alert.
    dlFiles: Number(env.DOWNLOAD_LIMIT_FILES || 500),
    dlBytes: gb(env.DOWNLOAD_LIMIT_GB, 20),
    port,
    host,
    publicUrl,
    secure: publicUrl.protocol === 'https:',
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
    tlsCert: env.TLS_CERT || null,
    tlsKey: env.TLS_KEY || null,
    trustProxy: env.TRUST_PROXY === '1',
    // Tailnet addresses of the public entrance on the VPS (Caddy): only requests from these may say, in
    // X-Relay-Client-IP, whose request they pass on.
    relayIps: (env.RELAY_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    appName: env.APP_NAME || 'Company Files',
    // Where the agent installers are downloaded from instead of this server (a better-connected one: the NAS's
    // internet upload is slow). /downloads/<installer> then redirects there. Unset: served from here.
    downloadsUrl: env.DOWNLOADS_URL ? new URL(env.DOWNLOADS_URL).href.replace(/\/+$/, '') : null,
    maxFile: gb(env.MAX_FILE_GB, 10),
    personalQuota: gb(env.PERSONAL_QUOTA_GB, 20),
    backupDir: env.BACKUP_DIR ? path.resolve(ROOT, env.BACKUP_DIR) : null,
    backupTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(env.BACKUP_TIME || '') ? env.BACKUP_TIME : '00:00',
    // Outgoing mail for sign-up codes. Without SMTP_HOST, invite links cannot be finished.
    // Collabora Online (in-browser editing of office files over WOPI). Off when unset.
    officeUrl: env.OFFICE_URL ? new URL(env.OFFICE_URL).origin : null,
    // The editor's address for people who came in through the VPS entrance (fast there); others use OFFICE_URL.
    officeRelayUrl: env.OFFICE_RELAY_URL ? new URL(env.OFFICE_RELAY_URL).origin : null,
    officeInternal: env.OFFICE_INTERNAL_URL ? new URL(env.OFFICE_INTERNAL_URL).origin : null, // where Files reads discovery
    pdfConverter: env.PDF_CONVERTER_URL ? new URL(env.PDF_CONVERTER_URL).origin : null, // PDF -> DOCX for editing PDFs
    wopiUrl: wopiUrl.origin,
    wopiPort: Number(env.WOPI_PORT) || null,
    smtp: env.SMTP_HOST
      ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.MAIL_FROM || env.SMTP_USER }
      : null,
  };
}

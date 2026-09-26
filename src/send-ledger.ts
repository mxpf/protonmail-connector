import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { PublicError } from '../shared/protocol.js';

export type Prepared = {raw: string; envelope: {from: string; to: string[]}; preview: unknown; messageId: string};
export class SendLedger {
  private db: DatabaseSync;
  constructor(path: string, private now = () => Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, expires INTEGER NOT NULL,
      state TEXT NOT NULL, payload TEXT, message_id TEXT NOT NULL);`);
  }
  prepare(mail: Prepared) {
    this.db.prepare('UPDATE sends SET payload=NULL WHERE expires < ?').run(this.now());
    const token = randomBytes(32).toString('hex');
    const expires = this.now() + 15 * 60_000;
    this.db.prepare('INSERT INTO sends VALUES (?, ?, ?, ?, ?)')
      .run(this.hash(token), expires, 'prepared', JSON.stringify(mail), mail.messageId);
    return {token, expiresAt: new Date(expires).toISOString(), preview: mail.preview};
  }
  async send(token: string, deliver: (mail: Prepared) => Promise<void>) {
    // Commit before SMTP: even a crash after acceptance must never allow a retry.
    const row = this.db.prepare(`UPDATE sends SET state='attempting' WHERE id=? AND state='prepared'
      AND expires>=? RETURNING payload, message_id`).get(this.hash(token), this.now());
    if (!row) throw new PublicError('send_unavailable', 'Send token expired, unknown, or already attempted. Do not retry the email automatically.');
    const mail = JSON.parse(row.payload as string) as Prepared;
    try { await deliver(mail); }
    catch {
      this.db.prepare("UPDATE sends SET state='unknown', payload=NULL WHERE id=?").run(this.hash(token));
      throw new PublicError('delivery_unknown', 'Delivery could not be confirmed. Check Sent before considering another attempt.', 502);
    }
    this.db.prepare("UPDATE sends SET state='sent', payload=NULL WHERE id=?").run(this.hash(token));
    return {status: 'accepted_by_smtp', messageId: mail.messageId};
  }
  close() { this.db.close(); }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
}

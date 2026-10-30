import {
  subscriptionId, grantExpiration, verifyCallback, sendEvent, validateCallbackUrl, EventProtocolError,
  type EventSubscribeParams, type EventUnsubscribeParams, type EventSubscriptionResult,
  type EventSubscription, type MessageEvent, type CallbackPolicy,
} from './events';

type Subscription = EventSubscription & { expires: string; previousUntil?: number; verifiedAt: number; generation: string };
type Outbox = { id: string; subscription: string; body: string; attempts: number; next: number; lease: string | null };
/** Narrow structural contract allows real SQLite tests without emulating the entire Workers runtime. */
export interface EventStoreContext {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    sync(): Promise<void>;
    transactionSync<T>(callback: () => T): T;
    sql: { exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): { toArray(): T[] } };
  };
}

export class EventStore {
  private readonly policy: CallbackPolicy;
  constructor(private ctx: EventStoreContext, hosts: string[], fetcher?: typeof fetch) {
    this.policy = { allowedHosts: hosts, ...(fetcher ? { fetch: fetcher } : {}) };
    this.ensureTables();
  }
  private async withGate<T>(callback: () => Promise<T>): Promise<T> {
    // A throw escaping blockConcurrencyWhile resets the Durable Object. Business
    // failures must cross the gate as values and only be thrown after release.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { ok: true as const, value: await callback() }; }
      catch (error) { return { ok: false as const, error }; }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  private ensureTables() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY,value TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,subscription TEXT,body TEXT,attempts INTEGER,next INTEGER,lease TEXT)');
    // Local prototype databases from earlier revisions may not have the lease column.
    const columns = sql.exec<{ name: string }>('PRAGMA table_info(outbox)').toArray();
    if (!columns.some((column) => column.name === 'lease')) sql.exec('ALTER TABLE outbox ADD COLUMN lease TEXT');
    sql.exec('CREATE TABLE IF NOT EXISTS event_revisions (id TEXT PRIMARY KEY,revision TEXT)');
  }
  private subscriptions(): Subscription[] {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM subscriptions').toArray().map((r) => JSON.parse(r.value) as Subscription);
  }
  private revision(id: string): string | undefined {
    return this.ctx.storage.sql.exec<{ revision: string }>('SELECT revision FROM event_revisions WHERE id=?', id).toArray()[0]?.revision;
  }
  async subscribe(params: EventSubscribeParams, oauthGrant?: string): Promise<EventSubscriptionResult> {
    validateCallbackUrl(params.delivery.url, this.policy);
    const id = await subscriptionId('self-hosted-owner', params);
    const ticket = crypto.randomUUID();
    const reservation = await this.withGate(async () => {
      if(oauthGrant && (await this.ctx.storage.get<{id:string}>('oauthGrant'))?.id!==oauthGrant)throw new EventProtocolError(-32602, 'OAuth grant is no longer active');
      const binding = await this.ctx.storage.get<{ generation: string }>('binding');
      if (!binding) throw new EventProtocolError(-32602, 'Bind Weixin first');
      this.ensureTables();
      const existing = this.subscriptions();
      if (existing.some((s) => s.id !== id && s.generation === binding.generation && Date.parse(s.expires) > Date.now())) {
        throw new EventProtocolError(-32602, 'Only one active chat subscription is supported; unsubscribe the previous chat first');
      }
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO event_revisions VALUES(?,?)', id, ticket);
      await this.ctx.storage.sync();
      const old = existing.find((s) => s.id === id && s.generation === binding.generation);
      return { generation: binding.generation, verified: !!old && old.secret === params.delivery.secret && old.url === params.delivery.url && old.verifiedAt > Date.now() - 300_000 };
    });
    // No long network I/O inside the concurrency gate.
    if (!reservation.verified) await verifyCallback({ id, url: params.delivery.url, secret: params.delivery.secret }, this.policy);
    return this.withGate(async () => {
      const binding = await this.ctx.storage.get<{ generation: string }>('binding');
      if (binding?.generation !== reservation.generation) throw new EventProtocolError(-32602, 'Binding changed');
      this.ensureTables();
      if (this.revision(id) !== ticket) throw new EventProtocolError(-32602, 'Subscription was cancelled or superseded');
      const current = this.subscriptions();
      if (current.some((s) => s.id !== id && s.generation === binding.generation && Date.parse(s.expires) > Date.now())) {
        throw new EventProtocolError(-32602, 'Another chat is already subscribed');
      }
      const old = current.find((s) => s.id === id && s.generation === binding.generation);
      const expires = grantExpiration(params.ttlMs);
      const sub: Subscription = {
        id, url: params.delivery.url, secret: params.delivery.secret, expires,
        generation: binding.generation, verifiedAt: reservation.verified && old ? old.verifiedAt : Date.now(),
        ...(old && old.secret !== params.delivery.secret ? { previousSecret: old.secret, previousUntil: Date.now() + 60_000 } :
          old?.previousSecret && old.previousUntil && old.previousUntil > Date.now() ? { previousSecret: old.previousSecret, previousUntil: old.previousUntil } : {}),
      };
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO subscriptions VALUES(?,?)', id, JSON.stringify(sub));
      await this.ctx.storage.sync();
      return { id, refreshBefore: expires, cursor: null, truncated: false };
    });
  }
  async unsubscribe(params: EventUnsubscribeParams): Promise<Record<string, never>> {
    const id = await subscriptionId('self-hosted-owner', params);
    return this.withGate(async () => {
      this.ensureTables();
      this.ctx.storage.transactionSync(() => {
        // Tombstone invalidates even a subscribe still waiting for callback verification.
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO event_revisions VALUES(?,?)', id, crypto.randomUUID());
        this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id=?', id);
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE subscription=?', id);
      });
      await this.ctx.storage.sync();
      return {};
    });
  }
  /** Called synchronously by account's binding-gated message transaction. */
  enqueue(message: { messageId: string; senderId: string; text: string }, now: number) {
    for (const sub of this.subscriptions()) {
      if (Date.parse(sub.expires) <= now) continue;
      const event: MessageEvent = { eventId: 'evt_' + crypto.randomUUID(), name: 'message.created', timestamp: new Date(now).toISOString(), data: message, cursor: null };
      this.ctx.storage.sql.exec('INSERT INTO outbox(id,subscription,body,attempts,next,lease) VALUES(?,?,?,0,?,NULL)', event.eventId, sub.id, JSON.stringify(event), now);
    }
  }
  async summary(): Promise<{ activeSubscriptions: number; pendingEvents: number; failedEvents: number }> {
    return this.withGate(async () => {
      const binding = await this.ctx.storage.get<{ generation: string }>('binding');
      if (!binding) return { activeSubscriptions: 0, pendingEvents: 0, failedEvents: 0 };
      this.ensureTables();
      return {
        activeSubscriptions: this.subscriptions().filter((s) => s.generation === binding.generation && Date.parse(s.expires) > Date.now()).length,
        pendingEvents: this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE attempts<5').toArray()[0]?.n ?? 0,
        failedEvents: this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE attempts>=5').toArray()[0]?.n ?? 0,
      };
    });
  }
  async flush() {
    for (let count = 0; count < 3; count++) {
      const claimed = await this.withGate(async () => {
        const binding = await this.ctx.storage.get<{ generation: string }>('binding');
        if (!binding) return null;
        this.ensureTables();
        const row = this.ctx.storage.sql.exec<Outbox>('SELECT * FROM outbox WHERE next<=? AND attempts<5 ORDER BY next LIMIT 1', Date.now()).toArray()[0];
        if (!row) return null;
        const sub = this.subscriptions().find((s) => s.id === row.subscription && s.generation === binding.generation);
        if (!sub || Date.parse(sub.expires) <= Date.now()) {
          this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?', row.id);
          return { skip: true as const };
        }
        if (sub.previousUntil && sub.previousUntil <= Date.now()) delete sub.previousSecret;
        const lease = crypto.randomUUID();
        // Lease exceeds the 10s network deadline and survives restart. Persist attempt
        // before I/O. Delivery is at-least-once: same eventId survives unknown outcomes.
        this.ctx.storage.sql.exec('UPDATE outbox SET attempts=attempts+1,next=?,lease=? WHERE id=?', Date.now() + 60_000, lease, row.id);
        await this.ctx.storage.sync();
        return { skip: false as const, generation: binding.generation, row, sub, lease };
      });
      if (!claimed) break;
      if (claimed.skip) continue;
      let outcome: { accepted: boolean; status: number; permanentFailure: boolean } | undefined;
      const guardedFetch: typeof fetch = async (input, init) => {
        let pending: Promise<Response> | undefined;
        await this.withGate(async () => {
          // Signing itself awaits crypto. Re-authorize immediately before starting
          // network I/O so unsubscribe/disconnect during signing cannot send data.
          const binding = await this.ctx.storage.get<{ generation: string }>('binding');
          if (binding?.generation !== claimed.generation) throw new EventProtocolError(-32602, 'Binding changed');
          this.ensureTables();
          const active = this.subscriptions().find((s) => s.id === claimed.sub.id && s.generation === binding.generation);
          const row = this.ctx.storage.sql.exec<Outbox>('SELECT * FROM outbox WHERE id=? AND lease=?', claimed.row.id, claimed.lease).toArray()[0];
          if (!active || Date.parse(active.expires) <= Date.now() || !row) throw new EventProtocolError(-32602, 'Subscription is no longer active');
          // Start fetch while authorization is gated, but await it after release.
          pending = (this.policy.fetch ?? fetch)(input, init);
        });
        if (!pending) throw new EventProtocolError(-32602, 'Delivery was cancelled');
        return pending;
      };
      try { outcome = await sendEvent(claimed.sub, JSON.parse(claimed.row.body) as MessageEvent, { ...this.policy, fetch: guardedFetch }); }
      catch { /* Retry boundedly; never log callbacks, payloads or secrets. */ }
      await this.withGate(async () => {
        // disconnect may have erased every SQL table while the webhook was in flight.
        const binding = await this.ctx.storage.get<{ generation: string }>('binding');
        if (binding?.generation !== claimed.generation) return;
        this.ensureTables();
        const row = this.ctx.storage.sql.exec<Outbox>('SELECT * FROM outbox WHERE id=? AND lease=?', claimed.row.id, claimed.lease).toArray()[0];
        if (!row) return; // unsubscribed or superseded while awaiting response
        if (outcome?.accepted) this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=? AND lease=?', row.id, claimed.lease);
        else {
          // Keep exhausted/permanent failures for status inspection instead of silently deleting.
          this.ctx.storage.sql.exec('UPDATE outbox SET attempts=?,next=?,lease=NULL WHERE id=? AND lease=?', outcome?.permanentFailure ? 5 : row.attempts,
            Date.now() + Math.min(300_000, 5_000 * 2 ** row.attempts), row.id, claimed.lease);
          if (outcome?.status === 410) this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id=?', claimed.sub.id);
        }
      });
    }
  }
}

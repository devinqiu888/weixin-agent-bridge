import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventStore, type EventStoreContext } from '../src/event-store';
import type { EventSubscribeParams } from '../src/events';

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const params: EventSubscribeParams = { name: 'message.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://callbacks.example.com/one', secret } };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(fetcher: typeof fetch) {
  const db = new DatabaseSync(':memory:');
  const values = new Map<string, unknown>([['binding', { generation: 'binding-1' }]]);
  let gate: Promise<unknown> = Promise.resolve();
  const ctx: EventStoreContext = {
    blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      const next = gate.then(callback); gate = next.catch(() => undefined); return next;
    },
    storage: {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async sync() {},
      transactionSync<T>(callback: () => T) { db.exec('SAVEPOINT test'); try { const result = callback(); db.exec('RELEASE test'); return result; } catch (cause) { db.exec('ROLLBACK TO test'); db.exec('RELEASE test'); throw cause; } },
      sql: { exec<T extends Record<string, SqlStorageValue>>(sql: string, ...bindings: SqlStorageValue[]) {
        const rows = db.prepare(sql).all(...bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
        return { toArray: () => rows as T[] };
      } },
    },
  };
  const store = new EventStore(ctx, ['callbacks.example.com'], fetcher);
  async function disconnect() {
    await ctx.blockConcurrencyWhile(async () => {
      values.delete('binding');
      db.exec('DROP TABLE subscriptions; DROP TABLE outbox; DROP TABLE event_revisions;');
    });
  }
  return { db, values, store, ctx, disconnect };
}
function echo(init?: RequestInit) { const body = JSON.parse(String(init?.body)); return Response.json({ challenge: body.challenge }); }

test('unsubscribe invalidates callback verification already in flight', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const { store, db } = fixture(async (_url, init) => { started.resolve(); await finish.promise; return echo(init); });
  const subscribing = store.subscribe(params);
  await started.promise;
  await store.unsubscribe({ ...params, delivery: { mode: 'webhook', url: params.delivery.url } });
  finish.resolve();
  await assert.rejects(subscribing, /cancelled or superseded/);
  assert.deepEqual(await store.summary(), { activeSubscriptions: 0, pendingEvents: 0, failedEvents: 0 });
  db.close();
});

test('disconnect during verification cannot resurrect credentials or erased tables', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const { store, disconnect, db } = fixture(async (_url, init) => { started.resolve(); await finish.promise; return echo(init); });
  const subscribing = store.subscribe(params);
  await started.promise; await disconnect(); finish.resolve();
  await assert.rejects(subscribing, /Binding changed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0);
  db.close();
});

test('concurrent flushes claim a single delivery; disconnect while in flight is safe', async () => {
  const started = deferred<void>(), finish = deferred<void>(); let deliveries = 0;
  const { store, disconnect, db } = fixture(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.type === 'verification') return echo(init);
    deliveries++; started.resolve(); await finish.promise; return new Response(null, { status: 204 });
  });
  await store.subscribe(params); store.enqueue({ messageId: 'm1', senderId: 'owner', text: 'hello' }, Date.now());
  const first = store.flush(); await started.promise;
  await store.flush(); assert.equal(deliveries, 1);
  await disconnect(); finish.resolve(); await first;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0);
  db.close();
});

test('retry exhaustion remains visible and eventId stays stable', async () => {
  const ids: string[] = [];
  const { store, db } = fixture(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.type === 'verification') return echo(init);
    ids.push(body.eventId); return new Response(null, { status: 503 });
  });
  await store.subscribe(params); store.enqueue({ messageId: 'm1', senderId: 'owner', text: 'hello' }, Date.now());
  for (let i = 0; i < 6; i++) { db.exec('UPDATE outbox SET next=0'); await store.flush(); }
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 1);
  assert.deepEqual(await store.summary(), { activeSubscriptions: 1, pendingEvents: 0, failedEvents: 1 });
  db.close();
});

test('refresh caches verification briefly; replacement signing key is verified and rotates', async () => {
  let verifications = 0;
  const { store, db } = fixture(async (_url, init) => { verifications++; return echo(init); });
  const first = await store.subscribe(params); const second = await store.subscribe(params);
  assert.equal(first.id, second.id); assert.equal(verifications, 1);
  await store.subscribe({ ...params, delivery: { ...params.delivery, secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64') } });
  assert.equal(verifications, 2);
  const stored = JSON.parse(String(db.prepare('SELECT value FROM subscriptions').get()?.value));
  assert.equal(stored.previousSecret, secret); assert.ok(stored.previousUntil > Date.now());
  db.close();
});

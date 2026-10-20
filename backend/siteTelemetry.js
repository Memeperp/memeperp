const crypto = require('crypto');
const store = require('./persistentStore');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const paths = new Set(['/', '/home.html', '/testnet.html', '/index.html', '/about.html', '/faq.html', '/testnet', '/mainnet', '/trade']);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const testPresence = new Map();
const testVisits = new Map();

async function heartbeat(body, identity) {
  if (![body?.visitorId, body?.sessionId, body?.visitId].every(value => typeof value === 'string' && uuid.test(value)) ||
    !paths.has(body.path) || typeof body.visible !== 'boolean') throw new Error('Invalid visitor heartbeat');
  const session = hash(body.sessionId), visitor = hash(body.visitorId), visit = hash(body.visitId);
  if (!store.enabled) {
    testPresence.set(session, { visitor, visible: body.visible, wallet: identity?.wallet, lastSeen: Date.now() });
    if (!testVisits.has(visit)) testVisits.set(visit, { visitor, path: body.path, at: Date.now() });
    return;
  }
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO site_presence(session_id,visitor_id,path,visible,wallet,chain) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id) DO UPDATE SET visitor_id=EXCLUDED.visitor_id,path=EXCLUDED.path,visible=EXCLUDED.visible,wallet=EXCLUDED.wallet,chain=EXCLUDED.chain,last_seen=now()',
      [session, visitor, body.path, body.visible, identity?.wallet || null, identity?.chain || null]);
    await client.query(
      'INSERT INTO site_visits(visitor_id,visit_id,path) VALUES($1,$2,$3) ON CONFLICT(visit_id) DO NOTHING',
      [visitor, visit, body.path]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function metrics() {
  if (!store.enabled) {
    const visits = [...testVisits.values()];
    const today = new Date().toISOString().slice(0, 10);
    const todayVisits = visits.filter(v => new Date(v.at).toISOString().startsWith(today));
    const live = [...testPresence.values()].filter(v => v.visible && Date.now() - v.lastSeen < 60000);
    return {
      totalVisits: visits.length, uniqueVisitors: new Set(visits.map(v => v.visitor)).size,
      todayVisits: todayVisits.length, todayUniqueVisitors: new Set(todayVisits.map(v => v.visitor)).size,
      liveVisitors: new Set(live.map(v => v.visitor)).size, liveSessions: live.length,
      authenticatedLiveUsers: new Set(live.filter(v => v.wallet).map(v => v.wallet)).size,
    };
  }
  const [visits, presence] = await Promise.all([
    store.pool.query(`SELECT count(*)::int AS "totalVisits",
      count(DISTINCT visitor_id)::int AS "uniqueVisitors",
      count(*) FILTER (WHERE (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date)::int AS "todayVisits",
      count(DISTINCT visitor_id) FILTER (WHERE (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date)::int AS "todayUniqueVisitors"
      FROM site_visits`),
    store.pool.query(`SELECT count(DISTINCT visitor_id)::int AS "liveVisitors",count(*)::int AS "liveSessions",
      count(DISTINCT wallet) FILTER (WHERE wallet IS NOT NULL)::int AS "authenticatedLiveUsers"
      FROM site_presence WHERE visible=true AND last_seen>now()-interval '60 seconds'`),
  ]);
  return { ...visits.rows[0], ...presence.rows[0] };
}
module.exports = { heartbeat, metrics };
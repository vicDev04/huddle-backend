import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { setNow } from '../src/time.js';

export { pool, setNow };
let app;
export async function getApp() { if (!app) app = await buildApp(); return app; }

let n = 0;
export const uname = () => `u${Date.now().toString(36)}${(n++).toString(36)}`.slice(0, 20);

export async function call(method, url, { token, body, headers = {} } = {}) {
  const a = await getApp();
  const res = await a.inject({ method, url, payload: body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  let json = null;
  try { json = res.json(); } catch {}
  return { status: res.statusCode, body: json, headers: res.headers };
}

export async function register(displayName = 'Tester', extra = {}) {
  const r = await call('POST', '/api/auth/register', {
    body: { username: uname(), password: 'password123', displayName, avatar: 'a01', color: '#7c5cff', ...extra },
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { token: r.body.token, user: r.body.user };
}

// Creates a crew with `size` members. Returns { group, members: [{token,user}] }
export async function crew(size) {
  const members = [];
  for (let i = 0; i < size; i++) members.push(await register(`P${i}`));
  const g = (await call('POST', '/api/groups', { token: members[0].token, body: { name: 'Test Crew' } })).body.group;
  for (const m of members.slice(1)) await call('POST', '/api/groups/join', { token: m.token, body: { inviteCode: g.inviteCode.toLowerCase() } });
  return { group: g, members };
}
export const byId = (members, id) => members.find((m) => m.user.id === id);

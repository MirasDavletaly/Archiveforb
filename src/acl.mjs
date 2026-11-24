import { MANAGE, AREAS } from './db.mjs';

/*
  Access model (spec section 4):
  - Access is granted on folders to groups or people: 1 Read, 2 Edit, 3 Manage.
  - A folder inherits everything granted above it.
  - A restricted folder (inherit = 0) inherits only Manage grants and the Managers group from above,
    so department heads and Managers keep access and everyone else must be added by name.
  - Confidential folders take named people only (no groups but Managers, if management decides).
  - Admin accounts are never members of groups and never in access lists: IT has no file access.
*/

// The depth cap means a parent/child cycle, should one ever appear, cannot hang the (synchronous) server.
const CHAIN = `WITH RECURSIVE c AS (
  SELECT nodes.*, 0 AS depth FROM nodes WHERE id = ?
  UNION ALL
  SELECT n.*, c.depth + 1 FROM nodes n JOIN c ON n.id = c.parent_id WHERE c.depth < 500)
SELECT * FROM c ORDER BY depth DESC`;

export function makeAcl(db) {
  const { everyone, managers } = db.ids;
  const ZERO = Object.freeze({ full: 0, pass: 0, area: null });

  function ctxFor(user) {
    const groups = new Set(db.all('SELECT group_id FROM members WHERE user_id = ?', user.id).map(r => r.group_id));
    if (!user.is_admin) groups.add(everyone);
    return { uid: user.id, groups };
  }
  // Structural lookups (admin screens, public links): sees the tree, matches no grants.
  const NOBODY = Object.freeze({ uid: 0, groups: new Set() });

  function entries(ids) {
    const m = new Map();
    for (const e of db.all('SELECT node_id, user_id, group_id, level FROM acl WHERE node_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))) {
      if (!m.has(e.node_id)) m.set(e.node_id, []);
      m.get(e.node_id).push(e);
    }
    return m;
  }

  // full = effective level here; pass = the part a restricted child would still inherit.
  function step(ctx, parent, node, list = []) {
    let own = 0, pass = 0;
    for (const e of list) {
      if (e.user_id !== ctx.uid && !ctx.groups.has(e.group_id)) continue;
      own = Math.max(own, e.level);
      if (e.level === MANAGE || e.group_id === managers) pass = Math.max(pass, e.level);
    }
    return {
      full: Math.max(own, node.inherit ? parent.full : parent.pass),
      pass: Math.max(pass, parent.pass),
      area: parent.area ?? node.area,
    };
  }
  const levelOf = (ctx, info) => info.full;

  // trashed: the item itself may be in the trash. anyDeleted: ignore the trash entirely (used by guards that
  // must count restricted folders hidden inside a trashed folder too).
  function finish(ctx, chain, infos, { trashed = false, anyDeleted = false } = {}) {
    const node = chain.at(-1);
    if (!anyDeleted && (chain.slice(0, -1).some(n => n.deleted_at) || (!trashed && node.deleted_at))) return null;
    const info = infos.at(-1);
    return {
      node,
      chain,
      infos,
      area: info.area,
      level: levelOf(ctx, info),
      parentLevel: chain.length > 1 ? levelOf(ctx, infos.at(-2)) : 0,
    };
  }

  function resolve(ctx, id, opts) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const chain = db.all(CHAIN, id);
    if (!chain.length || chain.at(-1).id !== id || chain[0].parent_id != null) return null; // cut off by the depth cap
    const ent = entries(chain.map(n => n.id));
    const infos = [];
    let info = ZERO;
    for (const n of chain) infos.push((info = step(ctx, info, n, ent.get(n.id))));
    return finish(ctx, chain, infos, opts);
  }

  // resolve() for listings that look up many items (search, trash, the activity log): every folder above is read
  // once and remembered, instead of once per item below it. Only for read-only requests: it does not see changes
  // made after a folder was read.
  function resolver(ctx) {
    const memo = new Map(); // id -> { chain, infos }, or null for "not in the tree"
    const walk = (id, depth = 0) => {
      if (memo.has(id)) return memo.get(id);
      memo.set(id, null); // a parent/child cycle ends here
      const node = depth < 500 && db.get('SELECT * FROM nodes WHERE id = ?', id);
      const up = node && (node.parent_id == null ? { chain: [], infos: [] } : walk(node.parent_id, depth + 1));
      const out = up && {
        chain: [...up.chain, node],
        infos: [...up.infos, step(ctx, up.infos.at(-1) ?? ZERO, node, db.all('SELECT node_id, user_id, group_id, level FROM acl WHERE node_id = ?', id))],
      };
      memo.set(id, out || null);
      return out;
    };
    return (id, opts) => {
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      const w = walk(id);
      return w && finish(ctx, w.chain, w.infos, opts);
    };
  }

  function children(ctx, r) {
    const rows = db.all(
      `SELECT n.*, u.name AS updated_by_name FROM nodes n LEFT JOIN users u ON u.id = n.updated_by
       WHERE n.parent_id = ? AND n.deleted_at IS NULL ORDER BY n.is_dir DESC, n.name COLLATE NOCASE`,
      r.node.id,
    );
    const parent = r.infos.at(-1);
    const ent = entries(rows.map(n => n.id));
    const out = [];
    for (const n of rows) {
      const level = levelOf(ctx, step(ctx, parent, n, ent.get(n.id)));
      if (level) out.push(Object.assign(n, { level }));
    }
    return out;
  }

  // Breadcrumbs stop at the highest folder the user can open; anything above is plain context text.
  function crumbs(ctx, r) {
    let i = r.chain.length - 1;
    while (i > 0 && levelOf(ctx, r.infos[i - 1]) > 0) i--;
    return {
      context: r.chain.slice(0, i).map(n => n.name).join(' / '),
      crumbs: r.chain.slice(i).map(n => ({ id: n.id, name: n.name })),
    };
  }

  // Entry points for the sidebar: folders the user can open whose parent they cannot.
  function spaces(ctx) {
    const ids = db
      .all('SELECT DISTINCT node_id FROM acl WHERE user_id = ? OR group_id IN (SELECT value FROM json_each(?))', ctx.uid, JSON.stringify([...ctx.groups]))
      .map(r => r.node_id);
    const out = [];
    const res = resolver(ctx);
    for (const id of ids) {
      const r = res(id);
      if (!r || !r.level || !r.node.is_dir || r.parentLevel) continue;
      out.push({
        id,
        name: r.node.name,
        area: r.area,
        level: r.level,
        root: r.chain.length === 1,
        context: r.chain.slice(1, -1).map(n => n.name).join(' / '),
      });
    }
    const key = s => `${s.context}/${s.name}`;
    return out.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || key(a).localeCompare(key(b)));
  }

  // Everything the access dialog shows: grants on this folder and what reaches it from above.
  function accessView(r) {
    const rows = db.all(
      `SELECT a.node_id, a.user_id, a.group_id, a.level, COALESCE(u.name, g.name) AS name, u.login, g.kind
       FROM acl a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN groups g ON g.id = a.group_id
       WHERE a.node_id IN (SELECT value FROM json_each(?)) ORDER BY a.level DESC, name`,
      JSON.stringify(r.chain.map(n => n.id)),
    );
    const fmt = e => ({ type: e.user_id ? 'user' : 'group', id: e.user_id ?? e.group_id, name: e.name, login: e.login ?? null, kind: e.kind ?? null, level: e.level });
    const at = id => rows.filter(e => e.node_id === id);
    const inherited = [];
    let filtered = false;
    for (let i = r.chain.length - 2; i >= 0; i--) {
      const from = r.chain.slice(0, i + 1).map(n => n.name).join(' / ');
      for (const e of at(r.chain[i].id)) {
        const pass = e.level === MANAGE || e.group_id === managers;
        if (!filtered || pass) inherited.push({ ...fmt(e), from, pass });
      }
      if (!r.chain[i].inherit) filtered = true;
    }
    return { own: at(r.node.id).map(fmt), inherited, restricted: !r.node.inherit };
  }

  return { ctxFor, NOBODY, levelOf, resolve, resolver, children, crumbs, spaces, accessView };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSetup, METADATA, TIERS } from '../setup.mjs';

const APP = '123456789012345678';
const GUILD = '223456789012345678';
const BOT = '323456789012345678';
const BOT_ROLE = '423456789012345678';
const TOKEN = 'private-bot-token';

const LIVE_BOT_ROLE = '1565746172428030236';
const LIVE_TIER_IDS = ['1565747151047364749', '1565747152305524746', '1565747153287127110', '1565747154423775303'];

function hierarchy(roles) {
  return roles.toSorted((left, right) => right.position - left.position || (BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0));
}

function fixture(overrides = {}) {
  const calls = [];
  const messages = [];
  let metadata = overrides.metadata || [{ type: 7, key: 'other', name: 'Other', description: 'Unrelated field' }];
  const roles = overrides.roles || [
    { id: GUILD, name: '@everyone', position: 0, permissions: '0', color: 0, hoist: false },
    { id: BOT_ROLE, name: 'Integration', position: 10, permissions: String(1 << 28), managed: true },
    { id: '523456789012345678', name: 'Moderator', position: 8, permissions: '8', color: 123, hoist: true },
    ...TIERS.map((tier, index) => ({ id: `62345678901234567${index}`, name: tier.name, position: index + 1, permissions: '1024', color: 0, hoist: false, mentionable: true })),
  ];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname.replace('/api/v10', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method, route, body, headers: options.headers });
    let result;
    if (route === '/oauth2/applications/@me') result = { id: overrides.appId || APP };
    else if (route === '/users/@me') result = { id: BOT };
    else if (route === `/guilds/${GUILD}/members/${BOT}`) result = { roles: [overrides.botRoleId || BOT_ROLE] };
    else if (route === `/applications/${APP}/role-connections/metadata`) {
      if (options.method === 'PUT') metadata = body;
      result = metadata;
    }
    else if (route === `/guilds/${GUILD}/roles` && options.method === 'GET') result = roles;
    else if (route === `/guilds/${GUILD}/roles` && options.method === 'POST') {
      const tierIndex = TIERS.findIndex((tier) => tier.name === body.name);
      const role = { ...body, id: overrides.createdIds?.[tierIndex] || `72345678901234567${roles.length}`, position: 1, managed: false };
      roles.push(role);
      result = role;
    } else if (route === `/guilds/${GUILD}/roles` && options.method === 'PATCH') {
      const rank = new Map(hierarchy(roles).reverse().map((role, index) => [role.id, index]));
      for (const change of body) rank.set(change.id, change.position);
      const reordered = roles.toSorted((left, right) => rank.get(left.id) - rank.get(right.id));
      reordered.forEach((role, index) => { role.position = index; });
      result = roles;
    } else if (route.startsWith(`/guilds/${GUILD}/roles/`) && options.method === 'PATCH') {
      const role = roles.find((item) => item.id === route.split('/').at(-1));
      Object.assign(role, body);
      result = role;
    } else throw new Error(`Unexpected route ${route}`);
    return Response.json(result);
  };
  return { calls, messages, roles, run: (args = []) => runSetup({ env: { DISCORD_CLIENT_ID: APP, DISCORD_BOT_TOKEN: TOKEN }, args, fetchImpl, log: (line) => messages.push(line) }) };
}

test('setup defaults to read-only planning and never prints its bot token', async () => {
  const f = fixture();
  await f.run(['--roles', '--guild', GUILD]);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
  assert.match(f.messages.join('\n'), /No changes made/);
  assert.doesNotMatch(f.messages.join('\n'), new RegExp(TOKEN));
  assert.ok(f.calls.every((call) => call.headers.Authorization === `Bot ${TOKEN}`));
});

test('setup preserves unrelated metadata and registers the exact credits comparator', async () => {
  const f = fixture();
  await f.run(['--apply']);
  const write = f.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(write.body, [{ type: 7, key: 'other', name: 'Other', description: 'Unrelated field' }, METADATA]);
  assert.equal(METADATA.type, 2);
  assert.equal(METADATA.description, 'Lifetime contribution credits on rodecomp.online');
  assert.ok(f.calls.every((call) => !call.route.includes('/guilds/')));
});

test('setup limits guild edits to exact color, hoist and tier-only hierarchy changes', async () => {
  const f = fixture();
  const { position: moderatorPosition, ...moderatorBefore } = f.roles.find((role) => role.name === 'Moderator');
  await f.run(['--apply', '--roles', '--guild', GUILD]);
  const updates = f.calls.filter((call) => call.method === 'PATCH' && call.route.includes('/roles/'));
  assert.equal(updates.length, 4);
  for (let index = 0; index < TIERS.length; index++) {
    assert.deepEqual(updates[index].body, { colors: { primary_color: TIERS[index].color, secondary_color: null, tertiary_color: null }, hoist: true });
    const role = f.roles.find((item) => item.name === TIERS[index].name);
    assert.equal(role.permissions, '1024');
    assert.equal(role.mentionable, true);
    assert.equal(role.position, 4 - index);
  }
  const { position: updatedPosition, ...moderatorAfter } = f.roles.find((role) => role.name === 'Moderator');
  assert.deepEqual(moderatorAfter, moderatorBefore);
  assert.ok(updatedPosition > f.roles.find((role) => role.name === 'Angeling').position);
  const order = f.calls.find((call) => call.method === 'PATCH' && call.route.endsWith('/roles'));
  assert.equal(order.body.length, 4);
  assert.ok(order.body.every((entry) => entry.id.startsWith('62345678901234567')));
  assert.ok(!f.calls.some((call) => call.method !== 'GET' && call.route.includes('/members/')));
});

test('new roles have no added permissions or mentionability', async () => {
  const initial = fixture();
  const f = fixture({ roles: initial.roles.filter((role) => !TIERS.some((tier) => tier.name === role.name)) });
  await f.run(['--apply', '--roles', '--guild', GUILD]);
  const creates = f.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 4);
  for (const call of creates) {
    assert.equal(call.body.permissions, '0');
    assert.equal(call.body.mentionable, false);
    assert.equal(call.body.hoist, true);
  }
});

test('wrong application and duplicate or unmanageable tier roles fail before writes', async () => {
  const wrong = fixture({ appId: '999999999999999999' });
  await assert.rejects(wrong.run(['--apply']), /does not belong/);
  assert.ok(wrong.calls.every((call) => call.method === 'GET'));
  for (const kind of ['duplicate', 'managed', 'above', 'older-at-bot-position']) {
    const f = fixture();
    const angeling = f.roles.find((role) => role.name === 'Angeling');
    if (kind === 'duplicate') f.roles.push({ ...angeling, id: '823456789012345678' });
    if (kind === 'managed') angeling.managed = true;
    if (kind === 'above') angeling.position = 11;
    if (kind === 'older-at-bot-position') { angeling.position = 10; angeling.id = '223456789012345679'; }
    await assert.rejects(f.run(['--apply', '--roles', '--guild', GUILD]));
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  }
});

test('new roles sharing position 1 with an older bot already have the correct Discord hierarchy', async () => {
  const f = fixture({ botRoleId: LIVE_BOT_ROLE, createdIds: LIVE_TIER_IDS, roles: [
    { id: GUILD, name: '@everyone', position: 0, permissions: '0' },
    { id: LIVE_BOT_ROLE, name: 'Integration', position: 1, permissions: String(1 << 28), managed: true },
  ] });
  await f.run(['--apply', '--roles', '--guild', GUILD]);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 4);
  assert.ok(f.roles.filter((role) => role.id !== GUILD).every((role) => role.position === 1));
  assert.deepEqual(hierarchy(f.roles).map((role) => role.name), ['Integration', ...TIERS.map((tier) => tier.name), '@everyone']);
  assert.ok(!f.calls.some((call) => call.method === 'PATCH' && call.route.endsWith('/roles')));
  const writesBefore = f.calls.filter((call) => call.method !== 'GET').length;
  await f.run(['--apply', '--roles', '--guild', GUILD]);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 4);
  assert.equal(f.calls.filter((call) => call.method !== 'GET').length, writesBefore);
});

test('tied tier roles reorder by hierarchy ranks while unrelated roles retain their relative order', async () => {
  const f = fixture({ botRoleId: LIVE_BOT_ROLE, roles: [
    { id: GUILD, name: '@everyone', position: 0, permissions: '0' },
    { id: LIVE_BOT_ROLE, name: 'Integration', position: 1, permissions: String(1 << 28), managed: true },
    { id: '1565747151500000000', name: 'Unrelated A', position: 1, permissions: '1024', color: 34, hoist: false },
    { id: '1565747153500000000', name: 'Unrelated B', position: 1, permissions: '2048', color: 56, hoist: true },
    ...TIERS.map((tier, index) => ({ id: LIVE_TIER_IDS[3 - index], name: tier.name, position: 1, permissions: '0', color: tier.color, hoist: true })),
  ] });
  const unrelatedBefore = f.roles.filter((role) => role.name.startsWith('Unrelated')).map(({ position, ...role }) => role);
  await f.run(['--apply', '--roles', '--guild', GUILD]);
  const ordering = f.calls.find((call) => call.method === 'PATCH' && call.route.endsWith('/roles'));
  assert.deepEqual(ordering.body, [
    { id: LIVE_TIER_IDS[3], position: 6 },
    { id: LIVE_TIER_IDS[2], position: 4 },
    { id: LIVE_TIER_IDS[1], position: 3 },
    { id: LIVE_TIER_IDS[0], position: 1 },
  ]);
  assert.deepEqual(hierarchy(f.roles).map((role) => role.name), ['Integration', 'Angeling', 'Unrelated A', 'Deviling', 'Metaling', 'Unrelated B', 'Poring', '@everyone']);
  assert.deepEqual(f.roles.filter((role) => role.name.startsWith('Unrelated')).map(({ position, ...role }) => role), unrelatedBefore);
});

test('metadata limit refuses to delete unrelated records', async () => {
  const f = fixture({ metadata: Array.from({ length: 5 }, (_, index) => ({ ...METADATA, key: `other_${index}` })) });
  await assert.rejects(f.run(['--apply']), /five other metadata/);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('Discord HTTP errors omit response bodies and authentication secrets', async () => {
  await assert.rejects(runSetup({ env: { DISCORD_CLIENT_ID: APP, DISCORD_BOT_TOKEN: TOKEN }, args: ['--apply'], fetchImpl: async () => new Response(`SECRET ${TOKEN}`, { status: 429 }), log: () => {} }), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /SECRET|private-bot-token/);
    return true;
  });
});

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const METADATA = Object.freeze({ type: 2, key: 'credits', name: 'Credits', description: 'Lifetime contribution credits on rodecomp.online' });
export const TIERS = Object.freeze([
  { name: 'Angeling', minimum: 10000, color: 0xF1C40F },
  { name: 'Deviling', minimum: 5000, color: 0x9B59B6 },
  { name: 'Metaling', minimum: 400, color: 0x74B9FF },
  { name: 'Poring', minimum: 50, color: 0xFF7675 },
]);

class SetupError extends Error {}

function snowflake(value, name) {
  if (!/^\d{17,20}$/.test(value || '')) throw new SetupError(`${name} must be a Discord ID`);
  return value;
}

function sameMetadata(left, right) {
  return ['type', 'key', 'name', 'description'].every((key) => left[key] === right[key]) && !left.name_localizations && !left.description_localizations;
}

// Discord orders equal numeric positions by snowflake: the older role is higher.
function compareRoles(left, right) {
  if (left.id === right.id) return 0;
  if (left.position !== right.position) return right.position - left.position;
  return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
}

export async function runSetup({ env = process.env, args = process.argv.slice(2), fetchImpl = fetch, log = console.log } = {}) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, roles: { type: 'boolean', default: false }, guild: { type: 'string' }, help: { type: 'boolean', default: false } }, allowPositionals: false });
  if (values.help) {
    log('Usage: node --env-file=.env.setup setup.mjs [--roles --guild GUILD_ID] [--apply]\nWithout --apply, reads Discord configuration and prints a plan only.\nRequired environment: DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN.');
    return;
  }
  const appId = snowflake(env.DISCORD_CLIENT_ID, 'DISCORD_CLIENT_ID');
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw new SetupError('DISCORD_BOT_TOKEN is required and must contain no whitespace');
  const guildId = values.roles ? snowflake(values.guild || env.DISCORD_GUILD_ID, 'Discord guild ID') : null;
  if (values.guild && !values.roles) throw new SetupError('--guild requires --roles');
  const api = async (method, route, body) => {
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10${route}`, {
        method,
        headers: { Authorization: `Bot ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-Audit-Log-Reason': 'Clank%20linked%20roles%20setup' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new SetupError('Discord request failed; check connectivity and retry setup'); }
    if (!response.ok) throw new SetupError(`Discord returned HTTP ${response.status}; check the application, token, guild permissions and rate limits before retrying`);
    try { return await response.json(); } catch { throw new SetupError('Discord returned an unexpected response'); }
  };
  const application = await api('GET', '/oauth2/applications/@me');
  if (application.id !== appId) throw new SetupError('The bot token does not belong to DISCORD_CLIENT_ID');
  const existingMetadata = await api('GET', `/applications/${appId}/role-connections/metadata`);
  if (!Array.isArray(existingMetadata)) throw new SetupError('Discord returned invalid role metadata');
  const otherMetadata = existingMetadata.filter((record) => record.key !== METADATA.key);
  if (otherMetadata.length >= 5) throw new SetupError('The application already has five other metadata fields; no fields were removed');
  const desiredMetadata = [...otherMetadata, METADATA];
  const currentCredits = existingMetadata.filter((record) => record.key === METADATA.key);
  const changeMetadata = currentCredits.length !== 1 || !sameMetadata(currentCredits[0], METADATA);
  let roles;
  let targetRoles;
  let botRoleIds;
  if (values.roles) {
    const bot = await api('GET', '/users/@me');
    roles = await api('GET', `/guilds/${guildId}/roles`);
    const member = await api('GET', `/guilds/${guildId}/members/${snowflake(bot.id, 'Bot user ID')}`);
    if (!Array.isArray(roles) || !Array.isArray(member.roles)) throw new SetupError('Discord returned invalid guild role data');
    botRoleIds = new Set(member.roles);
    const botRoles = roles.filter((role) => role.id === guildId || member.roles.includes(role.id));
    const permissions = botRoles.reduce((bits, role) => bits | BigInt(role.permissions), 0n);
    if (!(permissions & (1n << 3n)) && !(permissions & (1n << 28n))) throw new SetupError('The bot needs Manage Roles for optional guild role setup');
    const botHighest = botRoles.toSorted(compareRoles)[0];
    if (!botHighest || botHighest.id === guildId) throw new SetupError('Move the bot role above the contribution roles before running setup');
    targetRoles = TIERS.map((tier) => {
      const matches = roles.filter((role) => role.name === tier.name);
      if (matches.length > 1) throw new SetupError(`Multiple ${tier.name} roles exist; resolve duplicate names manually before setup`);
      const role = matches[0];
      if (role && (role.managed || role.id === guildId || compareRoles(role, botHighest) <= 0 || member.roles.includes(role.id))) throw new SetupError(`${tier.name} cannot be safely edited; it must be unmanaged, below the bot and not assigned to the bot`);
      return role || null;
    });
  }
  log(`${values.apply ? 'Applying' : 'Plan only:'} metadata credits, type 2 (integer greater than or equal), name Credits.`);
  if (values.roles) {
    for (let index = 0; index < TIERS.length; index++) {
      const tier = TIERS[index];
      log(`${targetRoles[index] ? 'Update' : 'Create'} ${tier.name}: #${tier.color.toString(16).toUpperCase().padStart(6, '0')}, hoist=true; manual Linked Roles requirement Credits >= ${tier.minimum}.`);
    }
    log('Order only these tier roles in their occupied hierarchy slots: Angeling > Deviling > Metaling > Poring. Preserve other role fields and unrelated role relative order.');
  }
  if (!values.apply) { log('No changes made. Add --apply to write this configuration.'); return; }
  if (changeMetadata) await api('PUT', `/applications/${appId}/role-connections/metadata`, desiredMetadata);
  if (values.roles) {
    for (let index = 0; index < TIERS.length; index++) {
      const tier = TIERS[index];
      const fields = { colors: { primary_color: tier.color, secondary_color: null, tertiary_color: null }, hoist: true };
      const role = targetRoles[index];
      if (role) {
        const color = role.colors?.primary_color ?? role.color;
        if (color !== tier.color || !role.hoist || role.colors?.secondary_color != null || role.colors?.tertiary_color != null) {
          targetRoles[index] = await api('PATCH', `/guilds/${guildId}/roles/${role.id}`, fields);
        }
      } else {
        targetRoles[index] = await api('POST', `/guilds/${guildId}/roles`, { name: tier.name, permissions: '0', mentionable: false, ...fields });
      }
    }
    // Newly created roles can all report position=1, including the bot's role.
    // Compare complete Discord ordering, not raw positions or distinct-slot assumptions.
    const refreshed = await api('GET', `/guilds/${guildId}/roles`);
    targetRoles = targetRoles.map((target) => refreshed.find((role) => role.id === target.id));
    const botHighest = refreshed.filter((role) => botRoleIds.has(role.id)).toSorted(compareRoles)[0];
    if (!botHighest || targetRoles.some((role) => !role || role.managed || botRoleIds.has(role.id) || compareRoles(role, botHighest) <= 0)) {
      throw new SetupError('Guild roles changed during setup; inspect the guild and rerun');
    }
    const targetIds = new Set(targetRoles.map((role) => role.id));
    const currentOrder = refreshed.toSorted(compareRoles);
    let tierIndex = 0;
    const desiredOrder = currentOrder.map((role) => targetIds.has(role.id) ? targetRoles[tierIndex++] : role);
    if (currentOrder.some((role, index) => role.id !== desiredOrder[index].id)) {
      // Positions are hierarchy ranks from @everyone=0. Move only the tier roles;
      // Discord renumbers intervening roles without changing their relative order.
      const positions = desiredOrder.flatMap((role, index) => targetIds.has(role.id) ? [{ id: role.id, position: desiredOrder.length - index - 1 }] : []);
      const updated = await api('PATCH', `/guilds/${guildId}/roles`, positions);
      const actualOrder = updated.toSorted(compareRoles);
      if (actualOrder.length !== desiredOrder.length || actualOrder.some((role, index) => role.id !== desiredOrder[index].id)) {
        throw new SetupError('Discord role hierarchy changed during setup; inspect the guild and rerun');
      }
    }
    log('Tier roles configured. No role membership was assigned or removed.');
  }
  log('Metadata registered. Finish each role’s Links requirements in Discord; this CLI cannot configure that UI.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup().catch((error) => {
    console.error(error instanceof SetupError ? error.message : 'Setup failed; check command options and Discord configuration.');
    process.exitCode = 1;
  });
}

// Discord Anti-Nuke Bot
// Run on your own machine, Railway, Fly.io, Replit, etc.
//
// Setup:
//   1. cd bot && npm install
//   2. Copy .env.example to .env and fill in DISCORD_TOKEN, GUILD_ID, API_URL, BOT_API_SECRET
//   3. node bot.js
//
// Required Discord bot permissions:
//   Administrator (easiest) OR: Manage Channels, Manage Roles, Ban Members, View Audit Log

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  AuditLogEvent,
} from "discord.js";

const {
  DISCORD_TOKEN,
  GUILD_ID,
  API_URL,
  BOT_API_SECRET,
  POLL_INTERVAL_MS = "5000",
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !API_URL || !BOT_API_SECRET) {
  console.error("Missing env vars. See .env.example");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

let OWNER_ID = null;
let WHITELIST = new Set();

// ---------- API helpers ----------
async function api(action, extra = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOT_API_SECRET}`,
    },
    body: JSON.stringify({ action, guild_id: "default", ...extra }),
  });
  if (!res.ok) throw new Error(`API ${action} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function refreshOwnerAndWhitelist() {
  try {
    const [{ config }, { whitelist }] = await Promise.all([
      api("get_owner"),
      api("list_whitelist"),
    ]);
    OWNER_ID = config?.owner_discord_id ?? null;
    WHITELIST = new Set((whitelist ?? []).map((w) => w.discord_user_id));
  } catch (e) {
    console.error("Failed to refresh config:", e.message);
  }
}

// ---------- Snapshot capture ----------
async function captureSnapshot(guild) {
  await guild.channels.fetch();
  await guild.roles.fetch();
  const bans = await guild.bans.fetch();

  const channels = guild.channels.cache.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    parent_id: c.parentId,
    position: c.position,
    topic: c.topic ?? null,
    nsfw: c.nsfw ?? false,
    bitrate: c.bitrate ?? null,
    user_limit: c.userLimit ?? null,
    rate_limit: c.rateLimitPerUser ?? null,
    permission_overwrites: c.permissionOverwrites
      ? [...c.permissionOverwrites.cache.values()].map((o) => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield.toString(),
          deny: o.deny.bitfield.toString(),
        }))
      : [],
  }));

  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id) // skip @everyone clone
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
      managed: r.managed,
    }));

  const banList = [...bans.values()].map((b) => ({
    user_id: b.user.id,
    username: b.user.username,
    reason: b.reason ?? null,
  }));

  return {
    data: { channels, roles, bans: banList, captured_at: new Date().toISOString() },
    channel_count: channels.length,
    role_count: roles.length,
    ban_count: banList.length,
  };
}

// ---------- Action handlers ----------
async function handleSaveState(guild) {
  const snap = await captureSnapshot(guild);
  await api("save_snapshot", {
    label: `auto-${new Date().toISOString()}`,
    ...snap,
  });
  return { ok: true, ...snap };
}

async function handleRestoreChannels(guild) {
  const { snapshot } = await api("get_snapshot");
  if (!snapshot) throw new Error("No snapshot found");
  const existing = new Set(guild.channels.cache.map((c) => c.name));
  let created = 0;
  for (const ch of snapshot.data.channels) {
    if (existing.has(ch.name)) continue;
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildCategory) continue;
    await guild.channels.create({ name: ch.name, type: ch.type, topic: ch.topic ?? undefined });
    created++;
  }
  return { created };
}

async function handleUnbanAll(guild) {
  const bans = await guild.bans.fetch();
  let count = 0;
  for (const ban of bans.values()) {
    try {
      await guild.bans.remove(ban.user.id, "Anti-nuke unban-all");
      count++;
    } catch (e) {
      console.error(`Failed to unban ${ban.user.id}:`, e.message);
    }
  }
  return { unbanned: count };
}

async function handleRecreateRoles(guild) {
  const { snapshot } = await api("get_snapshot");
  if (!snapshot) throw new Error("No snapshot found");
  const existing = new Set(guild.roles.cache.map((r) => r.name));
  let created = 0;
  for (const role of snapshot.data.roles) {
    if (role.managed || existing.has(role.name)) continue;
    await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: BigInt(role.permissions),
    });
    created++;
  }
  return { created };
}

async function handleHideChannels(guild, roleIds) {
  let updated = 0;
  for (const channel of guild.channels.cache.values()) {
    for (const roleId of roleIds) {
      try {
        await channel.permissionOverwrites.edit(roleId, {
          ViewChannel: false,
        });
        updated++;
      } catch (e) {
        // skip channels we can't edit
      }
    }
  }
  return { overwrites_updated: updated };
}

async function handleWhitelist(payload) {
  // Whitelist is stored via the dashboard / API; bot just acknowledges.
  await refreshOwnerAndWhitelist();
  return { user: payload.discord_user_id, whitelisted: true };
}

// ---------- Queue worker ----------
async function processQueue(guild) {
  const { job } = await api("poll");
  if (!job) return;

  console.log(`[${new Date().toISOString()}] Job:`, job.action);
  try {
    let result;
    switch (job.action) {
      case "save_state":        result = await handleSaveState(guild); break;
      case "restore_channels":  result = await handleRestoreChannels(guild); break;
      case "unban_all":         result = await handleUnbanAll(guild); break;
      case "whitelist_user":    result = await handleWhitelist(job.payload); break;
      case "recreate_roles":    result = await handleRecreateRoles(guild); break;
      case "fully_restore":
        result = {
          channels: await handleRestoreChannels(guild),
          roles: await handleRecreateRoles(guild),
          bans: await handleUnbanAll(guild),
        };
        break;
      case "hide_channels":     result = await handleHideChannels(guild, job.payload.role_ids ?? []); break;
      default: throw new Error(`Unknown action: ${job.action}`);
    }
    await api("complete", { queue_id: job.id, result });
    console.log("  \u2713 done");
  } catch (e) {
    console.error("  \u2717 failed:", e.message);
    await api("complete", { queue_id: job.id, error: e.message });
  }
}

// ---------- Anti-nuke watchers ----------
function isProtected(userId) {
  return userId === OWNER_ID || userId === client.user?.id || WHITELIST.has(userId);
}

async function getActor(guild, type) {
  const logs = await guild.fetchAuditLogs({ limit: 1, type });
  return logs.entries.first()?.executor?.id ?? null;
}

async function quarantine(guild, userId, reason) {
  if (isProtected(userId)) return;
  try {
    const member = await guild.members.fetch(userId);
    await member.roles.set([], `Anti-nuke: ${reason}`);
    console.log(`[anti-nuke] stripped roles from ${userId}: ${reason}`);
  } catch (e) {
    console.error(`[anti-nuke] failed to quarantine ${userId}:`, e.message);
  }
}

// ---------- Boot ----------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await refreshOwnerAndWhitelist();
  console.log(`Owner: ${OWNER_ID} | Whitelist: ${WHITELIST.size}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  setInterval(() => processQueue(guild).catch((e) => console.error("poll err:", e.message)), Number(POLL_INTERVAL_MS));
  setInterval(refreshOwnerAndWhitelist, 60_000);
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;
  const actor = await getActor(channel.guild, AuditLogEvent.ChannelDelete);
  if (actor) await quarantine(channel.guild, actor, "channel delete");
});

client.on("roleDelete", async (role) => {
  const actor = await getActor(role.guild, AuditLogEvent.RoleDelete);
  if (actor) await quarantine(role.guild, actor, "role delete");
});

client.on("guildBanAdd", async (ban) => {
  const actor = await getActor(ban.guild, AuditLogEvent.MemberBanAdd);
  if (actor) await quarantine(ban.guild, actor, "mass ban");
});

client.login(DISCORD_TOKEN);

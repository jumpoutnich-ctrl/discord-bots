# Discord Anti-Nuke Bot

The bot half of the system. Run this on your machine, Railway, Fly.io, Replit, or any always-on host.

## Setup

1. **Create a Discord app**: https://discord.com/developers/applications → New Application → Bot → Reset Token (copy it).
2. **Enable intents**: in the Bot tab, enable **Server Members Intent**, **Message Content Intent**, and **Presence Intent**.
3. **Invite to your server** with permissions: `Administrator` (easiest), or at minimum: Manage Channels, Manage Roles, Ban Members, View Audit Log.
4. **Configure**:
   ```bash
   cd bot
   cp .env.example .env
   # Edit .env: paste DISCORD_TOKEN, GUILD_ID, API_URL, BOT_API_SECRET
   npm install
   npm start
   ```
5. Bot prints `Logged in as YourBot#1234`. Open the dashboard, click **Save Current State** — within ~5s the bot will capture and store a snapshot.

## How it works

- **Dashboard** (Lovable app) → queues actions in the database.
- **Bot** polls `/api/public/bot` every 5s (using `BOT_API_SECRET`) for new actions.
- Bot executes via Discord API and posts the result back.
- Bot also watches for nuke patterns (mass channel/role deletes, mass bans) and strips roles from non-whitelisted attackers.

## Owner-only

The bot's `OWNER_ID` is loaded from the `bot_config` table (already set to your Discord ID `1425995437382308001`). Only actions queued through the dashboard run, and only the dashboard owner can reach the dashboard.

## Free hosting

- **Railway** — `railway up` from this folder, set env vars in dashboard.
- **Fly.io** — `fly launch`, then `fly secrets set DISCORD_TOKEN=... BOT_API_SECRET=...`.
- **Replit** — import this folder, paste env vars in Secrets tab.

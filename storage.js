const fs = require('fs');
const path = require('path');
const { todayDayNumber } = require('./group-schedule');

// Railway auto-injects RAILWAY_VOLUME_MOUNT_PATH once a Volume is attached
// to this service, pointing at that volume's mount path (e.g. "/data") —
// using it here means data.json lives on the persistent disk instead of
// inside the app's own code folder, so it survives every redeploy instead
// of getting wiped when Railway rebuilds from the latest GitHub push.
// DATA_DIR is a manual override for other hosts; falls back to this
// folder (old behavior) if neither is set, e.g. for local development.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// If this is the very first boot after attaching a fresh volume, the
// directory exists (Railway creates it) but nothing does — the rest of
// this module already handles a missing data.json fine (loadAll returns
// {}), so nothing else needs to change here.

// Registration runs 24/7 with no admin setup step — every guild gets a
// standing scrim automatically, sized generously (1000 groups) so it never
// needs to be manually resized.
const DEFAULT_TOTAL_SLOTS = 20000;

function defaultScrim() {
  return { scrimName: 'BGMI Scrim', totalSlots: DEFAULT_TOTAL_SLOTS, slots: {}, createdDayNumber: todayDayNumber() };
}

// Per-guild data shape:
// {
//   "<guildId>": {
//     scrim: { open, scrimName, totalSlots, slots: { "1": {...} } } | null,
//     tournaments: { "<tournamentId>": { id, name, open, groups: { "A": { capacity, teams: [] } }, qualified: [] } },
//       — several can exist at once; which one a given admin is currently
//       managing in the wizard panel is tracked in activeTournamentByUser.
//     activeTournamentByUser: { "<userId>": "<tournamentId>" },
//     warnings: { "<userId>": [ { reason, moderatorId, timestamp } ] },
//     verifications: { "<userId>": { team_name, owner_name, whatsapp, owner_email,
//       p1_ign, p1_uid, ..., p5_ign, p5_uid, registeredDate, teamNumber } },
//     ssVerifications: { "<userId>": { verifiedAt, matchedUsername, imageUrl } } —
//       Instagram-follow screenshot verification (see ss-verification.js),
//       separate from the team `verifications` above.
//     teams: { "<userId>": { teamName, players: [<string>], updatedAt } },
//     settings: { verifyLogChannelId: "<channelId>" | null, registrationLogChannelId: "<channelId>" | null,
//       privateRegistrationLogChannelId: "<channelId>" | null, privateVerifyLogChannelId: "<channelId>" | null,
//       verificationBackupChannelId: "<channelId>" | null, verificationBackupMessageId: "<messageId>" | null,
//       verifyTeamCounter: <number>, registeredRoleId: "<roleId>" | null, verifiedRoleId: "<roleId>" | null,
//       resultRoleId: "<roleId>" | null, verifyConfirmationMessage: "<text>" | null,
//       registerConfirmationMessage: "<text>" | null,
//       groupRoles: { "<groupLetter A-L>": "<roleId>" }, teamPanelRoleId: "<roleId>" | null,
//       ssVerifyChannelId: "<channelId>" | null, ssVerifyRoleId: "<roleId>" | null,
//       ssVerifyLogChannelId: "<channelId>" | null,
//       ssVerifyPlatform: "instagram" | "youtube" | "twitter" | null — which platform
//         is currently active, set via /ss-verify-panel (see ss-verification.js),
//       ssVerifyUsernames: { instagram: "<username>", youtube: "<username>", twitter: "<username>" } —
//         remembers a username per platform so switching platforms in the panel
//         doesn't lose the others' values,
//       instagramUsername: "<username>" | null — legacy field from before the panel
//         existed; auto-migrated into ssVerifyPlatform/ssVerifyUsernames on first read
//         (see migrateLegacySsSettings), left here only for old data.json files },
//     embeds: { "<name>": { title, description, color, url, image, thumbnail,
//       authorName, authorIcon, authorUrl, footerText, footerIcon, fields: [{name,value}] } }
//   }
// }

function loadAll() {
  // One-time migration: the first time this runs after attaching a volume,
  // the volume's data.json won't exist yet — but the *old* data.json (the
  // one that was living in the code folder, uploaded/committed before this
  // change) might still be sitting right next to this file. Seed the
  // volume from it once so existing verifications/registrations aren't
  // lost in the switch-over, instead of silently starting empty.
  if (!fs.existsSync(DATA_FILE)) {
    const legacyPath = path.join(__dirname, 'data.json');
    if (DATA_FILE !== legacyPath && fs.existsSync(legacyPath)) {
      try {
        fs.copyFileSync(legacyPath, DATA_FILE);
        console.log(`[storage] Migrated existing data.json into persistent volume at ${DATA_FILE}`);
      } catch (err) {
        console.error('[storage] Failed to migrate legacy data.json onto the volume:', err.message);
      }
    }
  }

  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse data.json, starting fresh:', err);
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getGuildStore(guildId) {
  const all = loadAll();
  if (!all[guildId]) {
    all[guildId] = { scrim: defaultScrim(), tournaments: {}, activeTournamentByUser: {}, warnings: {}, verifications: {}, ssVerifications: {}, teams: {}, settings: {}, embeds: {} };
    saveAll(all);
  }
  // backfill in case an older data.json is missing newer keys
  if (!all[guildId].scrim) all[guildId].scrim = defaultScrim();
  // Migration: guilds used to have a single `tournament` field (one
  // tournament at a time). Move it into the new `tournaments` map (keyed
  // by id, supports several running at once) the first time we see it,
  // then drop the old field so it doesn't get written back out.
  if (all[guildId].tournaments === undefined) {
    const legacy = all[guildId].tournament;
    all[guildId].tournaments = {};
    if (legacy) {
      const id = legacy.id || 't1';
      legacy.id = id;
      all[guildId].tournaments[id] = legacy;
    }
  }
  if (all[guildId].tournament !== undefined) delete all[guildId].tournament;
  if (all[guildId].activeTournamentByUser === undefined) all[guildId].activeTournamentByUser = {};
  if (all[guildId].warnings === undefined) all[guildId].warnings = {};
  if (all[guildId].verifications === undefined) all[guildId].verifications = {};
  if (all[guildId].ssVerifications === undefined) all[guildId].ssVerifications = {};
  if (all[guildId].teams === undefined) all[guildId].teams = {};
  if (all[guildId].settings === undefined) all[guildId].settings = {};
  if (all[guildId].embeds === undefined) all[guildId].embeds = {};
  return all[guildId];
}

function saveGuildStore(guildId, guildData) {
  const all = loadAll();
  all[guildId] = guildData;
  saveAll(all);
}

// Tracks the most recent /dm sent to each Discord user, globally (not
// scoped to one guild — DM channels have no guild context of their own).
// Lets a later reply in that DM get relayed back to wherever it came from.
// Stored under a reserved top-level key that can never collide with a real
// guild ID (guild IDs are pure numeric snowflakes).
function getDmThread(userId) {
  const all = loadAll();
  return (all._dmThreads && all._dmThreads[userId]) || null;
}

function setDmThread(userId, thread) {
  const all = loadAll();
  if (!all._dmThreads) all._dmThreads = {};
  all._dmThreads[userId] = thread;
  saveAll(all);
}

function listGuildIds() {
  return Object.keys(loadAll());
}

module.exports = { getGuildStore, saveGuildStore, getDmThread, setDmThread, listGuildIds, loadAll, saveAll };

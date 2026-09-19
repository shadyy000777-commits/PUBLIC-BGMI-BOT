const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType, AttachmentBuilder,
  MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const ExcelJS = require('exceljs');
const { getGuildStore, saveGuildStore } = require('./storage');
const {
  bindActiveTournament, getTournamentStore, listTournaments, getTournamentById,
  setActiveTournament, generateTournamentId,
} = require('./tournament-store');
const { buildGroupsEmbed, buildTournamentSlotListEmbed } = require('./embeds');
const {
  startPending: startRegPending, getPending: getRegPending,
  updatePending: updateRegPending, clearPending: clearRegPending,
} = require('./pending-tournament-registrations');
const {
  setDraft: setSwapDraft, getDraft: getSwapDraft, clearDraft: clearSwapDraft,
  createSwap, getSwap, updateSwap, deleteSwap,
} = require('./pending-group-swaps');

const RESTART_HINT = 'Click **Register Team** again to restart — no partial data is saved.';

const MAX_GROUPS = 60;
const DEFAULT_GROUP_CAPACITY = 20;
const MAX_GROUP_CAPACITY = 1000;
const MAX_TOTAL_SLOTS = 15000;
const MAX_ROUND = 10;
// Groups are keyed 1..MAX_GROUPS (plain numeric strings) rather than
// letters, so "Group 1", "Group 2"... display correctly everywhere they're
// already interpolated as `Group ${letter}` without needing a separate
// display-name lookup.
const GROUP_LETTERS = Array.from({ length: MAX_GROUPS }, (_, i) => String(i + 1));
const MAX_GUILD_ROLES = 250;
const MAX_GUILD_CHANNELS = 500;
const SAFETY_MARGIN = 5;

function isBanned(tournament, teamName) {
  return (tournament.bannedTeams || []).includes(teamName.toLowerCase());
}

function isDuplicateTeam(tournament, teamName) {
  return Object.values(tournament.groups)
    .some(g => g.teams.some(t => t.team.toLowerCase() === teamName.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Tournament list — entry point when several tournaments can exist at once.
// Pick one to open its wizard panel, or start a brand new one.
// ---------------------------------------------------------------------------
function buildTournamentListPayload(guildId) {
  const tournaments = listTournaments(guildId);

  const embed = new EmbedBuilder()
    .setTitle('🥇 Tournaments')
    .setColor(0x5865F2)
    .setDescription(
      tournaments.length
        ? 'Pick a tournament to manage, or create a new one — several can run at the same time.'
        : 'No tournaments yet. Click **Create Tournament** to start your first one.'
    );

  const rows = [];
  if (tournaments.length) {
    // Select menus cap at 25 options — plenty for any realistic number of
    // concurrently-running tournaments; extra ones just won't show up here.
    const select = new StringSelectMenuBuilder()
      .setCustomId('tourney_list_select')
      .setPlaceholder('Select a tournament to manage')
      .addOptions(tournaments.slice(0, 25).map(t => ({
        label: t.name.slice(0, 100),
        description: t.open ? 'Open' : 'Closed',
        value: t.id,
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create').setLabel('Create Tournament').setEmoji('➕').setStyle(ButtonStyle.Success),
  ));

  return { embeds: [embed], components: rows };
}

async function handleTournamentListSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const tid = interaction.values[0];
  const ok = setActiveTournament(interaction.guildId, interaction.user.id, tid);
  if (!ok) {
    return interaction.update({ content: '❌ That tournament no longer exists.', embeds: [], components: [] });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  await interaction.update({ content: '', ...buildTournamentWizardPayload(store) });
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
function buildTournamentWizardPayload(store) {
  const tournament = store.tournament;

  const embed = new EmbedBuilder()
    .setTitle(tournament ? `🥇 Tournament Setup — ${tournament.name}` : '🥇 Tournament Setup')
    .setColor(tournament ? (tournament.open ? 0x57F287 : 0xED4245) : 0x5865F2);

  if (!tournament) {
    embed.setDescription('No tournament is set up yet. Click **Create Tournament** to get started — the rest of these buttons need one to exist first.');
  } else {
    const groupCount = Object.keys(tournament.groups).length;
    const teamCount = Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
    const bannedCount = (tournament.bannedTeams || []).length;

    embed.addFields(
      { name: 'Status', value: tournament.open ? '🟢 Open' : '🔴 Closed', inline: true },
      { name: 'Groups', value: groupCount ? String(groupCount) : 'None yet', inline: true },
      { name: 'Teams Registered', value: String(teamCount), inline: true },
    );

    if (bannedCount) {
      embed.addFields({ name: '🔨 Banned Teams', value: String(bannedCount), inline: true });
    }
    if (tournament.slotManagerChannelId) {
      embed.addFields({ name: 'Slot-Manager Channel', value: `<#${tournament.slotManagerChannelId}>`, inline: true });
    }
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create').setLabel('Create Tournament').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tourney_wizard_toggle')
      .setLabel('Start/Pause Reg')
      .setEmoji(tournament && tournament.open ? '⏸️' : '▶️')
      .setStyle(tournament && tournament.open ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_manage_groups').setLabel('Manage Groups').setEmoji('🗂️').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_edit_settings').setLabel('Edit Settings').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_create_channels').setLabel('Create Channels').setEmoji('📺').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_ban_unban').setLabel('Ban/Unban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_cancel_slots').setLabel('Cancel Slots').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_add').setLabel('Manually Add Slot').setEmoji('📌').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_swap_group').setLabel('Swap Group').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_post_register_panel').setLabel('Post Register Panel').setEmoji('📮').setStyle(ButtonStyle.Success),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_slot_manager_channel').setLabel('Slot-Manager channel').setEmoji('📡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_excel_export').setLabel('MS Excel File').setEmoji('📊').setStyle(ButtonStyle.Primary),
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_delete').setLabel('Delete Tournament').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_back_to_list').setLabel('Other Tournaments').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tourney_wizard_help').setLabel('Help').setEmoji('❓').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// "Manage Groups" now goes straight to the group picker (see
// buildSlotListGroupSelectPayload, further down) — pick a group and its
// current slot list is shown. Nothing else to configure here manually
// since groups are auto-created from Total Slots / Teams-per-Group when
// Create Channels is hit, and each group's own channel carries its own
// admin panel (Publish Slot List / Punish Team / Result — see
// buildTournamentGroupAdminPanelPayload) for jobs scoped to that group.

// Sub-panel behind "Create Channels" — leads into the Channel Name /
// Category Name panel, which itself now creates one channel per group
// (see buildManualChannelCreationPayload).
function buildCreateChannelsSubmenuPayload() {
  const embed = new EmbedBuilder()
    .setTitle('📺 Create Channels')
    .setColor(0x5865F2)
    .setDescription(
      '**Create Channel** — set a naming format (defaults to `Group {number}`, use `{letter}` for A, B, C...) and a category name, then hit **Auto Channels** on the next screen to create every group\'s own channel under that category — one channel per group, in order (1, 2, 3...).'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create_channels_manual').setLabel('Create Channel').setEmoji('➕').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// Posted automatically in a group's own channel the moment that channel is
// created via "Create Channels" (Round 1) or a "Result" promotion (Round
// 2+) — the per-group counterpart to the top-level wizard panel, scoped to
// just this one group. Round-aware: the "Result" button (and its wording)
// changes depending on whether there's a next round to promote into.
function buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter) {
  const maxRounds = getMaxRounds(tournament);
  const isFinalRound = roundNum >= maxRounds;
  const title = roundNum > 1 ? `🛠️ Round ${roundNum} — Group ${letter} — Admin Panel` : `🛠️ Group ${letter} — Admin Panel`;
  const resultDescription = isFinalRound
    ? '**Result** picks this group\'s tournament winner — this is the last configured round, so only one team can be selected and no one is promoted further.'
    : `**Result** marks this group's qualifiers and promotes them into a Round ${roundNum + 1} group (its own role + channel), filling each Round ${roundNum + 1} group before moving to the next.`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865F2)
    .setDescription(`**Publish Slot List** posts this group\\'s current teams here. **Punish Team** bans a registered team and strips their roles. ${resultDescription}`);

  const tid = tournament.id;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_group_publish:${tid}:${roundNum}:${letter}`).setLabel('Publish Slot List').setEmoji('📤').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_punish:${tid}:${roundNum}:${letter}`).setLabel('Punish Team').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_result:${tid}:${roundNum}:${letter}`).setLabel('Result').setEmoji('🌟').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

// Public panel — this is the one meant to live in a #register-style
// channel where players (not admins) click to sign their team up. It's
// just an embed + the same Register Team button the admin panel used to
// carry, but posted on its own so players never see admin controls.
function buildTournamentRegisterPanelPayload(tournament) {
  const teamCount = Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
  const perGroupCapacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  // Effective max capacity for display — the smaller of the admin's overall
  // totalSlots cap (if set) and what MAX_GROUPS groups can actually hold.
  // Groups themselves are created lazily as they're needed, so this is a
  // ceiling, not a count of slots that already exist.
  const maxCapacity = Math.min(
    tournament.totalSlots || Infinity,
    MAX_GROUPS * perGroupCapacity,
  );

  const embed = new EmbedBuilder()
    .setTitle(`<a:30348trophyfixed:1549099959364878436> ${tournament.name} — Team Registration`)
    .setColor(tournament.open ? 0x57F287 : 0xED4245)
    .setDescription(
      tournament.open
        ? 'Click **Register Team** below, enter your team name, then mention your teammates. You\'ll be auto-assigned to whichever group still has room.'
        : '<:3409locked:1547663730786177095> Registration is currently closed.'
    )
    .addFields(
      { name: 'Status', value: tournament.open ? '<a:885679180799422574:1547663768702689280> Open' : '<a:836435400498741289:1547663764466180220> Closed', inline: true },
      { name: 'Slots Filled', value: Number.isFinite(maxCapacity) ? `${teamCount}/${maxCapacity}` : String(teamCount), inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_register_team:${tournament.id}`).setLabel('Register Team').setEmoji('📝').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}
// Quotient-style lettered settings screen — each field is edited by its own
// button (A-G) rather than one big modal, since Discord modals cap at 5
// text inputs and two of these fields (channel, role) need pickers anyway.
// Every pick saves immediately, so "Go Back" and "Save" both just return to
// the main panel — there's no separate unsaved draft to discard or commit.
function buildCreateSettingsPayload(tournament) {
  const embed = new EmbedBuilder()
    .setTitle('Enter details & Press Save')
    .setColor(0x5865F2)
    .addFields(
      { name: 'B. Confirm Channel', value: tournament.confirmChannelId ? `<#${tournament.confirmChannelId}>` : 'Not-Set' },
      { name: 'C. Required Mentions (0-4)', value: String(tournament.requiredMentions ?? 4) },
      { name: 'D. Teams per Group', value: tournament.teamsPerGroup ? String(tournament.teamsPerGroup) : 'Not-Set' },
      { name: 'E. Total Slots', value: tournament.totalSlots ? String(tournament.totalSlots) : 'Not-Set' },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_create_settings_b').setLabel('B').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_c').setLabel('C').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_d').setLabel('D').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_e').setLabel('E').setStyle(ButtonStyle.Primary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manage_rounds').setLabel('Manage Rounds').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_create_settings_back').setLabel('Go Back').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_create_settings_save').setLabel('Save').setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row1, row3, row4] };
}


function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('❓ Tournament Panel Help')
    .setColor(0x5865F2)
    .setDescription([
      '**Start/Pause Reg** — open or close team registration',
      '**Manage Groups** — pick a group to view its current slot list',
      '**Create Channels** — groups auto-generate from Total Slots / Teams-per-Group if none exist yet; press **Create Channel**, set a Channel Name and Category Name, then hit **Auto Channels** to create every group\'s own channel under that category',
      '**Each group\'s own channel** — carries its own panel: Publish Slot List, Punish Team, and Result, scoped to just that group',
      '**Edit Settings** — rename the tournament',
      '**Ban/Unban** — block or unblock a team name from registering',
      '**Cancel Slots** — remove a registered team from its group',
      '**Manually Add Slot** — pick a player, then a group, then enter the team name — force-registers them into that group (bypassing auto-assign) and gives them the group\'s role',
      '**Swap Group** — pick Team A and Team B, both owners must accept, then their groups (and roles) are swapped',
      '**Post Register Panel** — posts the public registration panel in this channel, for players to register themselves',
      '**Slot-Manager channel** — pick a channel where slot lists get published automatically, and where a self-service panel (Cancel My Slot / My Groups / Change Team Name) is posted for players',
      '**MS Excel File** — export the full slot list as a spreadsheet',
      '**Delete Tournament** — wipe everything and start over',
    ].join('\n'));
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function buildTournamentCreateModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_create_modal')
    .setTitle('Create Tournament')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. BGMI Winter Championship').setRequired(true).setMaxLength(80)
      ),
    );
}

function buildAddGroupModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_group_modal')
    .setTitle('Add Group')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('letter').setLabel(`Group number (1-${MAX_GROUPS})`).setStyle(TextInputStyle.Short)
          .setPlaceholder('1').setRequired(true).setMaxLength(2)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('capacity').setLabel('Team capacity').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 20').setRequired(true).setMaxLength(4)
      ),
    );
}

// Core group-creation math, shared by the "Create Channels" auto-setup path
// below. Fills GROUP_LETTERS sequentially with `perGroup`-capacity groups
// until `total` teams are covered. Returns null groups on validation error.
function computeAutoGroups(tournament, total, perGroup) {
  if (!Number.isInteger(total) || total < 1 || total > MAX_TOTAL_SLOTS) {
    return { error: `❌ Total teams must be a whole number between 1 and ${MAX_TOTAL_SLOTS}.` };
  }
  if (!Number.isInteger(perGroup) || perGroup < 1 || perGroup > MAX_GROUP_CAPACITY) {
    return { error: `❌ Teams per group must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.` };
  }

  const groupsNeeded = Math.ceil(total / perGroup);
  const freeLetters = GROUP_LETTERS.filter(l => !tournament.groups[l]);

  if (groupsNeeded > freeLetters.length) {
    return {
      error: `❌ That needs **${groupsNeeded}** new group(s), but only **${freeLetters.length}** letter slot(s) are free (max ${GROUP_LETTERS.length} groups total). Raise "teams per group" or delete an unused group first.`,
    };
  }

  const createdLetters = [];
  let remaining = total;
  for (let i = 0; i < groupsNeeded; i++) {
    const letter = freeLetters[i];
    const capacity = Math.min(perGroup, remaining);
    tournament.groups[letter] = { capacity, teams: [] };
    remaining -= capacity;
    createdLetters.push(letter);
  }

  return { createdLetters, groupsNeeded };
}

// Shared by both "Create Channels" paths (auto and manual) — makes sure
// groups exist before any channel gets created, auto-generating them from
// Total Slots / Teams-per-Group. Safe to call even if some groups already
// exist (e.g. a team registered before Create Channels was ever pressed,
// auto-creating just one group) — computeAutoGroups only fills in letters
// that are still free, so existing groups are left untouched. Returns an
// error string to show the admin, or null once groups are ready.
function ensureGroupsExist(interaction, store) {
  const tournament = store.tournament;
  if (!tournament.totalSlots) {
    if (Object.keys(tournament.groups).length) return null;
    return '❌ Set **Total Slots** first — Edit Settings → Total Slots (and Teams-per-Group, if you want something other than the default).';
  }
  const perGroup = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  const groupsAlreadyCovered = Object.keys(tournament.groups).length;
  const totalGroupsWanted = Math.ceil(tournament.totalSlots / perGroup);
  const stillNeeded = totalGroupsWanted - groupsAlreadyCovered;
  if (stillNeeded <= 0) return null;

  const result = computeAutoGroups(tournament, stillNeeded * perGroup, perGroup);
  if (result.error) return result.error;
  saveGuildStore(interaction.guildId, store);
  return null;
}

// Looks up (or auto-creates, once per group) the private role scoped to
// one tournament group. Registration calls this directly (role only, no
// channel) the moment a team lands in a group; createGroupChannels (the
// "Auto Channels" admin button) calls it too when it's time to actually
// make that group's channel — so whichever path runs first creates the
// role, and the other reuses it, instead of ever drifting apart.
//
// If the role already exists but under a different name than what's
// wanted now (e.g. registration created it with the default
// "Tournament Group {letter}" format before the admin ever set a custom
// Role Name, and Auto Channels is now asking for that custom name), it
// gets renamed in place rather than silently kept under its old name —
// otherwise a custom Role Name typed into the Auto Channels panel would
// only ever apply to brand-new groups, never ones that already had a
// team register into them.
//
// Never throws — a role-cap, permissions, or rename hiccup just logs and
// returns the role (or null), so it never blocks registration or channel
// creation outright.
async function ensureGroupRole(interaction, store, group, roleName, reason) {
  let role = group.roleId ? interaction.guild.roles.cache.get(group.roleId) : null;
  if (role) {
    if (role.name !== roleName) {
      try {
        role = await role.setName(roleName, reason);
      } catch (err) {
        console.error(`[tournament-group-role] Failed to rename role ${role.id} to "${roleName}" in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
    return role;
  }

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[tournament-group-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
    console.error(`[tournament-group-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping auto-create for "${roleName}".`);
    return null;
  }
  try {
    role = await interaction.guild.roles.create({ name: roleName, mentionable: false, reason });
    group.roleId = role.id;
    saveGuildStore(interaction.guildId, store);
    return role;
  } catch (err) {
    console.error(`[tournament-group-role] Failed to auto-create role "${roleName}" in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

// One tournament-wide role — "<Tournament Name> Winner" — created lazily
// the moment a winner is picked on the final round. Reused across re-runs
// of Result on the final group (tournament.winnerRoleId), same caching
// pattern as ensureGroupRole.
async function ensureWinnerRole(interaction, store, tournament) {
  let role = tournament.winnerRoleId ? interaction.guild.roles.cache.get(tournament.winnerRoleId) : null;
  if (role) return role;

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[tournament-winner-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
    console.error(`[tournament-winner-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping winner role creation.`);
    return null;
  }
  try {
    role = await interaction.guild.roles.create({
      name: `${tournament.name} Winner`,
      mentionable: false,
      reason: `Tournament "${tournament.name}" winner role`,
    });
    tournament.winnerRoleId = role.id;
    saveGuildStore(interaction.guildId, store);
    return role;
  } catch (err) {
    console.error(`[tournament-winner-role] Failed to auto-create winner role in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

// Shared by both "Create Channels" paths — actually creates the Discord
// channel for every group that has at least one registered team and
// doesn't have a channel yet, under `parentId` (or no category) using
// `nameFormat`. Groups with zero registered teams are skipped — e.g. 1000
// total slots at 20/group makes 50 possible groups, but if only 800 teams
// have registered so far, only the 40 groups that actually have teams get
// a channel; the rest wait until they fill up and Auto Channels is run
// again. "{letter}" is swapped for the group's internal letter (A, B,
// C...) and "{number}" for its 1-based position in that order (1, 2,
// 3...) — so an admin typing "Noble {number}" gets "Noble 1", "Noble 2",
// "Noble 3"... in order, while the groups are still tracked internally by
// letter. If the format uses neither token, "-{letter}" is appended so
// names stay unique across groups. Every channel comes out private — only
// that specific group's own role can see it (auto-created here if it
// doesn't have one yet), so a team registered into Group 1 can never see
// Group 2's channel, and it can't spin up threads — same lockdown
// regardless of which path made it.
async function createGroupChannels(interaction, store, { nameFormat, parentId, roleFormat }) {
  const tournament = store.tournament;
  const letters = Object.keys(tournament.groups).sort((a, b) => a.localeCompare(b));
  const hasLetterToken = /\{letter\}/i.test(nameFormat);
  const hasNumberToken = /\{number\}/i.test(nameFormat);
  const effectiveRoleFormat = roleFormat || getRoundNaming(tournament, 1).roleFormat;
  const hasRoleLetterToken = /\{letter\}/i.test(effectiveRoleFormat);
  const hasRoleNumberToken = /\{number\}/i.test(effectiveRoleFormat);

  const created = [];
  let missingRole = 0;
  let skippedEmpty = 0;
  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    const number = i + 1;
    const group = tournament.groups[letter];
    if (group.channelId && interaction.guild.channels.cache.has(group.channelId)) continue;
    // Skip groups nobody has registered into yet — e.g. 1000 slots / 20 per
    // group makes 50 possible groups, but if only 800 teams (40 groups'
    // worth) have actually registered, the other 10 stay empty and get no
    // channel. They'll get one automatically once a team lands in them and
    // Auto Channels is run again.
    if (!group.teams || group.teams.length === 0) { skippedEmpty++; continue; }

    // Best-effort private role per group — if it can't be made (missing
    // Manage Roles permission, role cap hit, etc.) the channel still gets
    // created below, just without that group-only lockdown, so a missing
    // role never blocks "create all the channels" outright. The role name
    // itself is admin-configurable ({number}/{letter} tokens, same as the
    // channel name) via the "Role Name" button on this panel — falling
    // back to "Tournament Group {letter}" if never set.
    let roleName = effectiveRoleFormat.replace(/\{round\}/gi, '1');
    if (hasRoleLetterToken) roleName = roleName.replace(/\{letter\}/gi, letter);
    if (hasRoleNumberToken) roleName = roleName.replace(/\{number\}/gi, String(number));
    if (!hasRoleLetterToken && !hasRoleNumberToken) roleName = `${roleName} ${letter}`;
    roleName = roleName.slice(0, 100); // Discord's hard cap on role name length
    const role = await ensureGroupRole(interaction, store, group, roleName, `Auto-created for Group ${letter} tournament registration`);
    const overwrites = role
      ? [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
          },
        ]
      : [];
    if (!role) missingRole++;

    let name = nameFormat.replace(/\{round\}/gi, '1');
    if (hasLetterToken) name = name.replace(/\{letter\}/gi, letter);
    if (hasNumberToken) name = name.replace(/\{number\}/gi, String(number));
    if (!hasLetterToken && !hasNumberToken) name = `${name}-${letter}`;
    try {
      const channel = await interaction.guild.channels.create({
        name: name.toLowerCase(),
        type: ChannelType.GuildText,
        parent: parentId || undefined,
        permissionOverwrites: overwrites,
        reason: `Tournament group channel created by ${interaction.user.tag}`,
      });
      group.channelId = channel.id;
      created.push(`<#${channel.id}>`);
      await channel.send(buildTournamentGroupAdminPanelPayload(tournament, 1, letter)).catch(() => {});
    } catch (err) {
      console.error(`[tournament] Failed to create channel for group ${letter}:`, err.message);
    }
  }
  saveGuildStore(interaction.guildId, store);
  return { created, missingRole, skippedEmpty };
}

// In-progress "Create Channel" (manual) data — Channel Format and Category
// Name are set one at a time via separate modals, so this bridges them
// until both are set and "Create Channels" is pressed. In-memory only: if
// the bot restarts mid-flow, the admin just presses the button again.
const pendingManualChannelCreation = new Map(); // key: `${guildId}:${userId}` -> { data, timer }
const MANUAL_CHANNEL_CREATION_TTL_MS = 15 * 60 * 1000;

function manualChannelCreationKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function setPendingChannelCreation(guildId, userId, fields) {
  const key = manualChannelCreationKey(guildId, userId);
  const existing = pendingManualChannelCreation.get(key);
  if (existing && existing.timer) clearTimeout(existing.timer);
  const data = { ...(existing ? existing.data : {}), ...fields };
  const timer = setTimeout(() => pendingManualChannelCreation.delete(key), MANUAL_CHANNEL_CREATION_TTL_MS);
  pendingManualChannelCreation.set(key, { data, timer });
  return data;
}

function getPendingChannelCreation(guildId, userId) {
  const entry = pendingManualChannelCreation.get(manualChannelCreationKey(guildId, userId));
  return entry ? entry.data : null;
}

function clearPendingChannelCreation(guildId, userId) {
  const key = manualChannelCreationKey(guildId, userId);
  const entry = pendingManualChannelCreation.get(key);
  if (entry && entry.timer) clearTimeout(entry.timer);
  pendingManualChannelCreation.delete(key);
}

// Panel behind "Create Channel" — set Channel Name (format) and Category
// Name (each via its own modal), then Auto Channels creates every group's
// own channel, named from that format, under a category with that name
// (an existing category of that name is reused if one already exists).
function buildManualChannelCreationPayload(data) {
  const ready = Boolean(data.channelFormat && data.categoryName);
  const embed = new EmbedBuilder()
    .setTitle('📺 Tournament Channel Creation')
    .setColor(ready ? 0x57F287 : 0x5865F2)
    .setDescription(
      'Creates a channel for every **filled** group (empty groups with no registered teams are skipped) under the category below. ' +
      'Use `{number}` in the channel name for 1, 2, 3... or `{letter}` for A, B, C...'
    )
    .addFields(
      { name: 'Channel Name', value: data.channelFormat ? `\`${data.channelFormat}\`` : '`Not Set`' },
      { name: 'Category Name', value: data.categoryName ? `\`${data.categoryName}\`` : '`Not Set`' },
      { name: 'Role Name', value: data.roleFormat ? `\`${data.roleFormat}\`` : '`Tournament Group {letter}` (default)' },
      { name: 'Status', value: ready ? '✅ Ready — hit Auto Channels.' : '🔒 Set both the channel name and category name to continue' },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_format').setLabel('Channel Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_category').setLabel('Category Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_role').setLabel('Role Name').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_auto_create').setLabel('Auto Channels').setEmoji('⚙️').setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_cancel').setLabel('Cancel').setEmoji('🚫').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildAutoGroupsModal(tournament) {
  const totalInput = new TextInputBuilder().setCustomId('total').setLabel('Total teams expected').setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 720').setRequired(true).setMaxLength(5);
  if (tournament && tournament.totalSlots) totalInput.setValue(String(tournament.totalSlots));

  const perGroupInput = new TextInputBuilder().setCustomId('per_group').setLabel('Teams per group').setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 20').setRequired(true).setMaxLength(4);
  if (tournament && tournament.teamsPerGroup) perGroupInput.setValue(String(tournament.teamsPerGroup));

  return new ModalBuilder()
    .setCustomId('tourney_wizard_auto_groups_modal')
    .setTitle('Auto-Create Groups')
    .addComponents(
      new ActionRowBuilder().addComponents(totalInput),
      new ActionRowBuilder().addComponents(perGroupInput),
    );
}

// Modal only collects the team name — Discord modals can't hold a user-select
// component, so the 4 player mentions are picked in a follow-up step (see
// buildMentionPlayersRow) after this is submitted.
function buildRegisterTeamModal(tid) {
  return new ModalBuilder()
    .setCustomId(`tourney_wizard_register_modal:${tid}`)
    .setTitle('Register Team')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80)
      ),
    );
}

function buildMentionPlayersRow(count = 4) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('tourney_reg_select_players')
    .setPlaceholder(`Mention the ${count} player${count === 1 ? '' : 's'} on your team`)
    .setMinValues(count)
    .setMaxValues(count);
  return new ActionRowBuilder().addComponents(menu);
}

function tourneyConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_reg_confirm').setLabel('Confirm Registration').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_reg_cancel').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );
}

// Whether any of the newly-picked player IDs is already locked into another
// team's roster in this tournament — a player can only be mentioned on one
// team at a time. Returns the conflicting user ID and their team, or null.
function findTournamentLineupConflict(tournament, selectedIds) {
  for (const group of Object.values(tournament.groups)) {
    for (const t of group.teams) {
      for (const id of t.playerIds || []) {
        if (selectedIds.includes(id)) {
          return { conflictId: id, team: t.team };
        }
      }
    }
  }
  return null;
}

function buildTeamRegPreviewEmbed(data) {
  const lineup = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_none selected_';
  return new EmbedBuilder()
    .setTitle('📝 Review Your Registration')
    .setColor(0xFEE75C)
    .setDescription(`**Team Name** — ${data.team}\n**Players** — ${lineup}`)
    .setFooter({ text: 'Double-check everything, then tap Confirm to lock in your slot.' });
}

function buildEditSettingsModal(tournament) {
  const nameInput = new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(80);
  if (tournament && tournament.name) nameInput.setValue(tournament.name);

  return new ModalBuilder()
    .setCustomId('tourney_wizard_edit_modal')
    .setTitle('Edit Settings')
    .addComponents(new ActionRowBuilder().addComponents(nameInput));
}

function buildBanUnbanModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_ban_modal')
    .setTitle('Ban / Unban Team')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
          .setPlaceholder('Exact team name — running this again unbans it').setRequired(true).setMaxLength(80)
      ),
    );
}

// "Manually Add Slot" is a 3-step flow:
//   1. Pick the player (UserSelectMenu) — this is who the group role gets
//      given to, same as a normal self-registration owner.
//   2. Pick which group to drop them into (StringSelectMenu, groups with a
//      free slot only) — both the picked user and picked group travel
//      through the customId of each step instead of a typed group number.
//   3. A short modal for the team name + player IGNs, then the team is
//      pushed into that group and the selected member is given the
//      group's role (auto-creating it first if it doesn't exist yet).
function buildManualAddUserSelectPayload() {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('tourney_manual_add_user_select')
    .setPlaceholder('Select the player to add')
    .setMinValues(1)
    .setMaxValues(1);

  const embed = new EmbedBuilder()
    .setTitle('📌 Manually Add Slot')
    .setColor(0x5865F2)
    .setDescription('Select the player you want to add — they\'ll be the one who gets the group\'s role.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildManualAddGroupSelectPayload(tournament, userId) {
  const letters = Object.keys(tournament.groups).filter(l => tournament.groups[l].teams.length < tournament.groups[l].capacity);
  if (!letters.length) {
    return { error: '❌ Every group is already full — add another group first.' };
  }
  if (letters.length > 25) {
    // Discord select menus cap at 25 options — trim to the first 25 open
    // groups rather than failing outright.
    letters.length = 25;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tourney_manual_add_group_select:${userId}`)
    .setPlaceholder('Select a group to add them to')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(letters.slice(0, 25).map(letter => ({
      label: `Group ${letter}`,
      description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
      value: letter,
    })));

  const embed = new EmbedBuilder()
    .setTitle('📌 Manually Add Slot')
    .setColor(0x5865F2)
    .setDescription(`Adding <@${userId}> — pick which group to place them in.`);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function buildManualAddSlotModal(userId, letter) {
  return new ModalBuilder()
    .setCustomId(`tourney_wizard_manual_add_modal:${userId}:${letter}`)
    .setTitle(`Add to Group ${letter}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('player1').setLabel('Player 1 IGN').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(40)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('player2').setLabel('Player 2 IGN').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(40)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('players34').setLabel('Player 3 & 4 IGN (comma separated)').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(80)
      ),
    );
}

async function handleManualAddUserSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const userId = interaction.values[0];
  const payload = buildManualAddGroupSelectPayload(tournament, userId);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleManualAddGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, userId] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const letter = interaction.values[0];

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }
  if (tournament.groups[letter].teams.length >= tournament.groups[letter].capacity) {
    return interaction.update({ content: `❌ Group **${letter}** just filled up — run **Manually Add Slot** again.`, embeds: [], components: [] });
  }

  return interaction.showModal(buildManualAddSlotModal(userId, letter));
}

// ---------------------------------------------------------------------------
// Swap Group
// ---------------------------------------------------------------------------
// A 4-step flow: pick Team A, pick Team B, both team owners have to accept
// via buttons on a public confirmation message, then — only once both have
// — the two teams' groups are actually swapped (their roles moved with
// them, since that's what gates each group's channel — see the comment
// above the Round 1 role grant further up).
//
// Scoped to Round 1 groups (tournament.groups) — the same scope every other
// button on this top-level panel (Cancel Slots, Manually Add Slot, ...)
// already operates in. Round 2+ groups have their own per-group admin panel.

// Lists every Round-1 team as `{ letter, idx, team }`, sorted by group then
// slot number, capped at 25 (Discord's hard limit on select options) since
// there's no pagination here yet — same trade-off buildManualAddGroupSelectPayload
// already makes for the groups list.
function listAllTeams(tournament) {
  const out = [];
  for (const letter of Object.keys(tournament.groups).sort((a, b) => Number(a) - Number(b))) {
    tournament.groups[letter].teams.forEach((team, idx) => out.push({ letter, idx, team }));
  }
  return out;
}

// side: 'a' | 'b'. exclude: { letter, idx } of the already-picked team (only
// passed for side 'b') so it can't be picked again as its own opponent.
function buildSwapTeamSelectPayload(tournament, side, exclude) {
  let entries = listAllTeams(tournament);
  if (entries.length < 2) {
    return { error: '❌ You need at least 2 registered teams to swap groups.' };
  }
  if (exclude) {
    entries = entries.filter(e => !(e.letter === exclude.letter && e.idx === exclude.idx));
  }
  const trimmed = entries.length > 25;
  entries = entries.slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId(side === 'a' ? 'tourney_swap_team_a_select' : 'tourney_swap_team_b_select')
    .setPlaceholder(side === 'a' ? 'Select Team A' : 'Select Team B')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(entries.map(e => ({
      label: e.team.team.slice(0, 100),
      description: `Group ${e.letter}`,
      value: `${e.letter}:${e.idx}`,
    })));

  const embed = new EmbedBuilder()
    .setTitle('🔄 Swap Group')
    .setColor(0x5865F2)
    .setDescription(
      side === 'a'
        ? 'Select the first team.'
        : `**Team A:** ${exclude.teamName} (Group ${exclude.letter})\n\nNow select the second team to swap with.`
    );
  if (trimmed) {
    embed.setFooter({ text: 'Only the first 25 teams are shown — this list may not be complete.' });
  }

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleSwapTeamASelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const [letter, idxStr] = interaction.values[0].split(':');
  const idx = parseInt(idxStr, 10);
  const group = tournament.groups[letter];
  const team = group && group.teams[idx];
  if (!team) {
    return interaction.update({ content: '❌ That team no longer exists — start over.', embeds: [], components: [] });
  }

  setSwapDraft(interaction.user.id, {
    tournamentId: tournament.id,
    letterA: letter,
    idxA: idx,
    teamAName: team.team,
    ownerAId: team.ownerId || null,
  });

  const payload = buildSwapTeamSelectPayload(tournament, 'b', { letter, idx, teamName: team.team });
  if (payload.error) {
    clearSwapDraft(interaction.user.id);
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  return interaction.update(payload);
}

async function handleSwapTeamBSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const draft = getSwapDraft(interaction.user.id);
  if (!draft) {
    return interaction.update({ content: '❌ That swap setup expired — click **Swap Group** again.', embeds: [], components: [] });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament || tournament.id !== draft.tournamentId) {
    clearSwapDraft(interaction.user.id);
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const [letter, idxStr] = interaction.values[0].split(':');
  const idx = parseInt(idxStr, 10);
  const group = tournament.groups[letter];
  const team = group && group.teams[idx];
  if (!team) {
    clearSwapDraft(interaction.user.id);
    return interaction.update({ content: '❌ That team no longer exists — start over.', embeds: [], components: [] });
  }
  if (letter === draft.letterA && idx === draft.idxA) {
    return interaction.update({ content: '❌ Team B can\'t be the same team as Team A — start over.', embeds: [], components: [] });
  }
  if (!draft.ownerAId || !team.ownerId) {
    clearSwapDraft(interaction.user.id);
    return interaction.update({
      content: '❌ One of these teams has no linked owner (it was likely added before this feature existed), so there\'s no one to send a confirmation to.',
      embeds: [], components: [],
    });
  }
  if (draft.letterA === letter) {
    clearSwapDraft(interaction.user.id);
    return interaction.update({ content: '❌ Both teams are already in the same group.', embeds: [], components: [] });
  }

  const swapId = createSwap({
    guildId: interaction.guildId,
    tournamentId: tournament.id,
    letterA: draft.letterA,
    teamAName: draft.teamAName,
    ownerAId: draft.ownerAId,
    letterB: letter,
    teamBName: team.team,
    ownerBId: team.ownerId,
    requestedBy: interaction.user.id,
  });
  clearSwapDraft(interaction.user.id);

  await interaction.update({
    content: '✅ Swap request posted below — waiting on both team owners to respond.',
    embeds: [], components: [],
  });
  await interaction.channel.send(buildSwapRequestPayload(getSwap(swapId), swapId)).catch(() => {});
}

// Renders the public confirmation message both owners see and act on. Each
// side's two buttons are disabled once that side has decided, so an owner
// can't double-click or change their mind after the fact — Reject on either
// side ends the whole thing anyway.
function buildSwapRequestPayload(swap, swapId) {
  const statusFor = (decision) => decision === 'accept' ? '✅ Accepted' : decision === 'reject' ? '❌ Rejected' : '⏳ Waiting for response';

  const embed = new EmbedBuilder()
    .setTitle('🔄 Group Swap Request')
    .setColor(0x5865F2)
    .setDescription(`Requested by <@${swap.requestedBy}> — both owners must accept for the swap to go through.`)
    .addFields(
      { name: `Team A — ${swap.teamAName}`, value: `Group ${swap.letterA} → Group ${swap.letterB}\nOwner: <@${swap.ownerAId}>\nStatus: ${statusFor(swap.aDecision)}`, inline: true },
      { name: `Team B — ${swap.teamBName}`, value: `Group ${swap.letterB} → Group ${swap.letterA}\nOwner: <@${swap.ownerBId}>\nStatus: ${statusFor(swap.bDecision)}`, inline: true },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_swap_decision:${swapId}:a:accept`).setLabel(`${swap.teamAName} — Accept`).setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!!swap.aDecision),
    new ButtonBuilder().setCustomId(`tourney_swap_decision:${swapId}:a:reject`).setLabel(`${swap.teamAName} — Reject`).setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(!!swap.aDecision),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_swap_decision:${swapId}:b:accept`).setLabel(`${swap.teamBName} — Accept`).setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!!swap.bDecision),
    new ButtonBuilder().setCustomId(`tourney_swap_decision:${swapId}:b:reject`).setLabel(`${swap.teamBName} — Reject`).setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(!!swap.bDecision),
  );

  return { content: `<@${swap.ownerAId}> <@${swap.ownerBId}>`, embeds: [embed], components: [row1, row2] };
}

async function handleSwapDecision(interaction) {
  const [, swapId, side, action] = interaction.customId.split(':');
  const swap = getSwap(swapId);
  if (!swap) {
    return interaction.reply({ content: '❌ This swap request has expired or was already resolved.', flags: MessageFlags.Ephemeral });
  }

  const expectedOwnerId = side === 'a' ? swap.ownerAId : swap.ownerBId;
  if (interaction.user.id !== expectedOwnerId) {
    return interaction.reply({ content: `❌ Only <@${expectedOwnerId}> can respond for that team.`, flags: MessageFlags.Ephemeral });
  }

  if (action === 'reject') {
    deleteSwap(swapId);
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xED4245)
      .addFields({ name: '\u200b', value: `❌ **${side === 'a' ? swap.teamAName : swap.teamBName}** rejected the swap — nothing has changed.` });
    return interaction.update({ content: null, embeds: [embed], components: [] });
  }

  const updated = updateSwap(swapId, side === 'a' ? { aDecision: 'accept' } : { bDecision: 'accept' });
  if (!(updated.aDecision === 'accept' && updated.bDecision === 'accept')) {
    // Only one side has accepted so far — reflect that and keep waiting.
    return interaction.update(buildSwapRequestPayload(updated, swapId));
  }

  // Both accepted — perform the actual swap now.
  const store = getTournamentStore(interaction.guildId, updated.requestedBy);
  const tournament = store.tournament;
  if (!tournament || tournament.id !== updated.tournamentId) {
    deleteSwap(swapId);
    return interaction.update({ content: '❌ The tournament no longer exists — swap cancelled.', embeds: [], components: [] });
  }

  const result = await performGroupSwap(interaction, store, tournament, updated);
  deleteSwap(swapId);

  if (!result.ok) {
    return interaction.update({ content: `❌ ${result.reason}`, embeds: [], components: [] });
  }

  const embed = new EmbedBuilder()
    .setTitle('🔄 Group Swap Complete')
    .setColor(0x57F287)
    .setDescription(
      `**${updated.teamAName}** is now in **Group ${updated.letterB}**\n` +
      `**${updated.teamBName}** is now in **Group ${updated.letterA}**` +
      (result.roleWarnings.length ? `\n\n${result.roleWarnings.join('\n')}` : '')
    );
  return interaction.update({ content: null, embeds: [embed], components: [] });
}

// Swaps the two teams' array entries in place (so slot numbers stay put —
// only the content moves), then moves each owner's group role to match —
// that role is what gates a group's channel (see the comment above the
// Round 1 role grant, further up), so this is also what "updates their
// channel access" in practice. Re-checks both teams still exist right
// before touching anything, in case a Cancel Slot happened while the
// owners were deciding.
async function performGroupSwap(interaction, store, tournament, swap) {
  const groupA = tournament.groups[swap.letterA];
  const groupB = tournament.groups[swap.letterB];
  if (!groupA || !groupB) {
    return { ok: false, reason: 'One of the groups no longer exists.' };
  }

  const idxA = groupA.teams.findIndex(t => t.team.toLowerCase() === swap.teamAName.toLowerCase());
  const idxB = groupB.teams.findIndex(t => t.team.toLowerCase() === swap.teamBName.toLowerCase());
  if (idxA === -1) return { ok: false, reason: `**${swap.teamAName}** is no longer in Group ${swap.letterA}.` };
  if (idxB === -1) return { ok: false, reason: `**${swap.teamBName}** is no longer in Group ${swap.letterB}.` };

  const teamAObj = groupA.teams[idxA];
  const teamBObj = groupB.teams[idxB];
  groupA.teams[idxA] = teamBObj;
  groupB.teams[idxB] = teamAObj;
  saveGuildStore(interaction.guildId, store);

  const roleWarnings = [];
  const roleA = await ensureGroupRole(
    interaction, store, groupA,
    applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: swap.letterA, separator: ' ' }),
    `Group swap by ${interaction.user.tag}`,
  ).catch(() => null);
  const roleB = await ensureGroupRole(
    interaction, store, groupB,
    applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: swap.letterB, separator: ' ' }),
    `Group swap by ${interaction.user.tag}`,
  ).catch(() => null);

  // teamAObj now sits in groupB, so its owner needs Group B's role (and
  // loses Group A's); teamBObj mirrors that the other way.
  async function moveRole(ownerId, oldRole, newRole, newLetter) {
    if (!ownerId) return;
    const member = interaction.guild.members.cache.get(ownerId) ?? await interaction.guild.members.fetch(ownerId).catch(() => null);
    if (!member) {
      roleWarnings.push(`⚠️ Couldn't find <@${ownerId}> in this server to update their roles.`);
      return;
    }
    if (oldRole) await member.roles.remove(oldRole.id).catch(() => {});
    if (newRole) {
      await member.roles.add(newRole.id).catch(() => {
        roleWarnings.push(`⚠️ Couldn't give <@${ownerId}> the Group ${newLetter} role — check my **Manage Roles** permission and role position.`);
      });
    } else {
      roleWarnings.push(`⚠️ Couldn't create/find a role for Group ${newLetter}.`);
    }
  }
  await moveRole(swap.ownerAId, roleA, roleB, swap.letterB);
  await moveRole(swap.ownerBId, roleB, roleA, swap.letterA);

  return { ok: true, roleWarnings };
}

function buildRequiredMentionsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Required Mentions (1-4)').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(1).setPlaceholder('4');
  if (tournament.requiredMentions) input.setValue(String(tournament.requiredMentions));
  return new ModalBuilder().setCustomId('tourney_create_settings_d_modal').setTitle('Required Mentions')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildTeamsPerGroupModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Teams per Group').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(4).setPlaceholder('e.g. 20');
  input.setValue(String(tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY));
  return new ModalBuilder().setCustomId('tourney_create_settings_e_modal').setTitle('Teams per Group')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildTotalSlotsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Total Slots').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(5).setPlaceholder('e.g. 15000');
  if (tournament.totalSlots) input.setValue(String(tournament.totalSlots));
  return new ModalBuilder().setCustomId('tourney_create_settings_f_modal').setTitle('Total Slots')
    .addComponents(new ActionRowBuilder().addComponents(input));
}




function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// ---------------------------------------------------------------------------
// Button handler
// ---------------------------------------------------------------------------
async function handleTournamentWizardButton(interaction) {
  const id = interaction.customId;

  // Public: any player can register a team, no Manage Server needed.
  // These panels are posted for one specific tournament, so the id they
  // were posted for travels with the button instead of depending on
  // whichever tournament an admin happens to have open right now.
  if (id.startsWith('tourney_wizard_register_team:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    if (!tournament.open) {
      const content = tournament.closedReason === 'full'
        ? '🔒 Registration is closed — all slots are full.'
        : '❌ Registration is currently closed.';
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    // Safety net for the rare case registration is still marked open but
    // capacity was already hit (e.g. totalSlots got lowered after the
    // fact) — normally auto-close in handleTourneyRegConfirm means this
    // never actually gets reached with room to spare.
    if (isRegistrationFull(tournament)) {
      return interaction.reply({ content: '🔒 Registration is closed — all slots are full.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildRegisterTeamModal(tid));
  }

  // Public: continuing the register flow, also no Manage Server needed.
  // The tournament id was stashed in the pending registration record back
  // when the modal was submitted.
  if (id === 'tourney_wizard_reg_confirm') {
    return handleTourneyRegConfirm(interaction);
  }
  if (id === 'tourney_wizard_reg_cancel') {
    return handleTourneyRegCancel(interaction);
  }

  // Public: self-service slot management, posted in a tournament's own
  // Slot-Manager channel — any registered player can cancel their own
  // slot, check which group they're in, or rename their own team. No
  // Manage Server permission needed for any of these. Same as above, the
  // tournament id rides along on the button/modal customId.
  if (id.startsWith('tourney_wizard_selfservice_cancel:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_cancel_confirm:${tid}`).setLabel('Yes, Cancel My Slot').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_wizard_selfservice_cancel_abort').setLabel('Never Mind').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `⚠️ Cancel **${entry.team.team}**'s registration in Group **${entry.letter}**? This removes your tournament role(s) and frees the slot for someone else. This can't be undone.`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_selfservice_cancel_abort') {
    return interaction.update({ content: "✅ No changes made — you're still registered.", components: [] });
  }

  if (id.startsWith('tourney_wizard_selfservice_cancel_confirm:')) {
    const tid = id.split(':')[1];
    const store = getGuildStore(interaction.guildId);
    const tournament = store.tournaments && store.tournaments[tid];
    if (!tournament) {
      return interaction.update({ content: '❌ This tournament no longer exists.', components: [] });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      return interaction.update({ content: "❌ You're not registered for this tournament.", components: [] });
    }

    await interaction.deferUpdate();

    const { letter, group, team } = entry;
    await removeTeamFromRoundOnward(interaction, store, tournament, team, 2);
    const groupRoleId = group.roleId;
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (groupRoleId) await member.roles.remove(groupRoleId).catch(() => {});
    }

    group.teams = group.teams.filter(t => t !== team);
    tournament.qualified = tournament.qualified.filter(name => name !== team.team);
    saveGuildStore(interaction.guildId, store);

    return interaction.editReply({ content: `🗑️ **${team.team}** has been removed from Group ${letter} — your tournament roles have been cleared.`, components: [] });
  }

  if (id.startsWith('tourney_wizard_selfservice_my_groups:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const { letter, team, idx } = entry;
    const lineup = (team.playerIds && team.playerIds.length)
      ? team.playerIds.map(id => `<@${id}>`).join(' ')
      : (team.players || []).join(' ');
    return interaction.reply({
      content: `📋 **${team.team}** is in **Group ${letter}**, Slot **${idx + 1}**.\n👥 ${lineup}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id.startsWith('tourney_wizard_selfservice_change_name:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId(`tourney_selfservice_change_name_modal:${tid}`).setTitle('Change Team Name');
    const input = new TextInputBuilder()
      .setCustomId('team').setLabel('New team name').setStyle(TextInputStyle.Short)
      .setValue(entry.team.team).setMaxLength(100).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_back_to_list') {
    return interaction.update({ content: '', ...buildTournamentListPayload(interaction.guildId) });
  }

  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  // Everything from here down is admin-only and acts on whichever
  // tournament this admin currently has open in the wizard.
  const store = getTournamentStore(interaction.guildId, interaction.user.id);

  if (id === 'tourney_wizard_create') {
    // Several tournaments can exist at once now — always allowed. Creating
    // one makes it this admin's active tournament in the wizard.
    return interaction.showModal(buildTournamentCreateModal());
  }

  if (id === 'tourney_create_settings_b') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new ChannelSelectMenuBuilder().setCustomId('tourney_create_confirmchannel_select')
      .setPlaceholder('Choose the confirm channel').addChannelTypes(ChannelType.GuildText);
    return interaction.update({ content: 'B. Pick the confirm channel:', embeds: [], components: [new ActionRowBuilder().addComponents(select)] });
  }

  if (id === 'tourney_create_settings_c') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildRequiredMentionsModal(store.tournament));
  }

  if (id === 'tourney_create_settings_d') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildTeamsPerGroupModal(store.tournament));
  }

  if (id === 'tourney_create_settings_e') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildTotalSlotsModal(store.tournament));
  }

  if (id === 'tourney_create_settings_back' || id === 'tourney_create_settings_save') {
    // Everything on this screen saves the moment it's picked, so both
    // buttons do the same thing: drop back to the main panel.
    return interaction.update(buildTournamentWizardPayload(store));
  }

  if (id === 'tourney_wizard_manage_groups') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildSlotListGroupSelectPayload(store.tournament);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_edit_settings') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_wizard_ban_unban') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildBanUnbanModal());
  }

  if (id === 'tourney_wizard_post_register_panel') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('tourney_register_panel_channel_select')
      .setPlaceholder('Choose a channel to post the registration panel in')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.reply({
      content: '📮 Pick a channel — players will register from there.',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_manual_add') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    if (!Object.keys(store.tournament.groups).length) {
      return interaction.reply({ content: '❌ Add a group first.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildManualAddUserSelectPayload(), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_swap_group') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildSwapTeamSelectPayload(store.tournament, 'a', null);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    clearSwapDraft(interaction.user.id);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_cancel_slots') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildCancelGroupSelectPayload(store.tournament);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_slot_manager_channel') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('tourney_slotmanager_channel_select')
      .setPlaceholder('Choose the slot-manager channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.reply({
      content: '📡 Pick a channel — published slot lists will be posted there.',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_create_channels') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildCreateChannelsSubmenuPayload(), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_create_channels_manual') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ I need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    }

    // Pre-fill from Manage Rounds -> Round 1 (Channel / Role / Category
    // name) so the admin doesn't retype them; anything already edited in
    // this session wins over the saved value.
    const roundOne = (store.tournament.rounds && store.tournament.rounds[1]) || {};
    const seed = {};
    if (roundOne.channelFormat) seed.channelFormat = roundOne.channelFormat;
    if (roundOne.categoryName) seed.categoryName = roundOne.categoryName;
    if (roundOne.roleFormat) seed.roleFormat = roundOne.roleFormat;
    const existing = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { ...seed, ...existing });
    return interaction.reply({ ...buildManualChannelCreationPayload(data), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_manual_channels_set_format') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const modal = new ModalBuilder().setCustomId('tourney_manual_channels_format_modal').setTitle('Channel Format');
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Name ({number}=1,2,3.. or {letter}=A,B,C..)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Group {number}')
      .setValue(data.channelFormat || 'Group {number}')
      .setRequired(true)
      .setMaxLength(80);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_manual_channels_set_category') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const modal = new ModalBuilder().setCustomId('tourney_manual_channels_categoryname_modal').setTitle('Category Name');
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Name for the new category')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('🥇 Tournament Groups')
      .setValue(data.categoryName || '')
      .setRequired(true)
      .setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_manual_channels_set_role') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const modal = new ModalBuilder().setCustomId('tourney_manual_channels_rolename_modal').setTitle('Role Name');
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Name ({number}=1,2,3.. or {letter}=A,B,C..)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Tournament Group {letter}')
      .setValue(data.roleFormat || 'Tournament Group {letter}')
      .setRequired(true)
      .setMaxLength(80);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_manual_channels_cancel') {
    clearPendingChannelCreation(interaction.guildId, interaction.user.id);
    return interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] });
  }

  if (id === 'tourney_wizard_manual_channels_auto_create') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id);
    if (!data || !data.channelFormat || !data.categoryName) {
      return interaction.reply({ content: '❌ Set both Channel Name and Category Name first.', flags: MessageFlags.Ephemeral });
    }
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const groupsErr = ensureGroupsExist(interaction, store);
    if (groupsErr) {
      return interaction.reply({ content: groupsErr, flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ I need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    }
    // Manage Roles is only needed to lock each group's channel down to
    // that group's own players — nice to have, but its absence should
    // never stop the channels themselves from being created.
    const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);

    await interaction.deferUpdate();

    // Reuse an existing category with this exact name (case-insensitive)
    // if the admin already ran this before, rather than spawning a fresh
    // duplicate category every time Auto Channels is pressed.
    let category = interaction.guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === data.categoryName.toLowerCase()
    );
    if (!category) {
      try {
        category = await interaction.guild.channels.create({
          name: data.categoryName,
          type: ChannelType.GuildCategory,
          reason: `Tournament group channels category created by ${interaction.user.tag}`,
        });
      } catch (err) {
        console.error('[tournament] Failed to create category:', err.message);
        return interaction.editReply({ content: '❌ Failed to create the category — check my **Manage Channels** permission.', embeds: [], components: [] });
      }
    }

    const { created, missingRole, skippedEmpty } = await createGroupChannels(interaction, store, {
      nameFormat: data.channelFormat,
      parentId: category.id,
      roleFormat: data.roleFormat,
    });

    const roleWarning = !canManageRoles
      ? '\n⚠️ I don\'t have **Manage Roles**, so these channels aren\'t locked to their own group — grant it and re-run to lock them down.'
      : missingRole
        ? `\n⚠️ ${missingRole} group role(s) couldn't be created (role cap or a permissions hiccup) — those channels are visible to everyone for now.`
        : '';
    const skippedNote = skippedEmpty
      ? `\nℹ️ Skipped ${skippedEmpty} empty group(s) — no teams registered yet. Re-run Auto Channels once they fill up.`
      : '';

    clearPendingChannelCreation(interaction.guildId, interaction.user.id);
    return interaction.editReply({
      content: created.length
        ? `✅ Created under **${category.name}**: ${created.join(', ')}${roleWarning}${skippedNote}`
        : `ℹ️ Every filled group already has a channel (or channel creation failed — check my permissions).${roleWarning}${skippedNote}`,
      embeds: [],
      components: [],
    });
  }

  if (id === 'tourney_wizard_excel_export') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Slot List');
    sheet.columns = [
      { header: 'Group', key: 'group', width: 10 },
      { header: 'Slot', key: 'slot', width: 8 },
      { header: 'Team', key: 'team', width: 30 },
      { header: 'Players', key: 'players', width: 50 },
    ];
    for (const [letter, group] of Object.entries(store.tournament.groups).sort(([a], [b]) => a.localeCompare(b))) {
      group.teams.forEach((t, idx) => {
        // Newer registrations store real Discord IDs in playerIds (from the
        // mention-based flow) — resolve those to readable tags for the
        // spreadsheet instead of dumping raw <@id> mention text. Older
        // registrations (typed IGNs, no playerIds) fall back to t.players as-is.
        const playerLabels = (t.playerIds && t.playerIds.length)
          ? t.playerIds.map(id => interaction.guild.members.cache.get(id)?.user.tag ?? `<@${id}>`)
          : (t.players || []);
        sheet.addRow({ group: letter, slot: idx + 1, team: t.team, players: playerLabels.join(', ') });
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `tournament-${(store.tournament.name || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`;
    const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: filename });
    return interaction.editReply({ content: '📊 Full slot list export:', files: [attachment] });
  }

  if (id === 'tourney_wizard_help') {
    return interaction.reply({ embeds: [buildHelpEmbed()], flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_manage_rounds') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildRoundListPayload(store.tournament), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_toggle') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    store.tournament.open = !store.tournament.open;
    // Any manual flip (open or closed) overrides whatever auto-closed it
    // before — otherwise the register button would keep reporting "all
    // slots are full" after an admin manually reopens it, or a manual
    // close would misleadingly claim slots are full.
    store.tournament.closedReason = null;
    saveGuildStore(interaction.guildId, store);
    const payload = buildTournamentWizardPayload(store);
    await interaction.update(payload);
    await refreshRegisterPanel(interaction.guild, store.tournament);
    await interaction.channel.send(
      store.tournament.open
        ? `✅ Registration opened for **${store.tournament.name}**. Teams can now register.`
        : `🔒 Registration for **${store.tournament.name}** is now closed.`
    ).catch(() => {});
    return;
  }

  // View Groups / Slot List / Qualify used to live on the top-level panel —
  // removed in favor of each group's own channel panel below, which covers
  // publish/punish/result scoped to that specific group.

  // These three live on a per-group channel panel that outlives any one
  // admin session, so — unlike the rest of this function — they resolve
  // their tournament explicitly from the id baked into the button instead
  // of from this admin's active-tournament pointer above.
  if (id.startsWith('tourney_wizard_group_publish:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const rawStore = getGuildStore(interaction.guildId);
    const tournament = rawStore.tournaments && rawStore.tournaments[tid];
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    return handleTourneyGroupPublish(interaction, rawStore, tournament, parseInt(roundStr, 10), letter);
  }

  if (id.startsWith('tourney_wizard_group_punish:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament || !getRoundGroups(tournament, roundNum)[letter]) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildTournamentPunishSelectPayload(tournament, tid, roundNum, letter);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('tourney_wizard_group_result:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament || !getRoundGroups(tournament, roundNum)[letter]) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildQualifySelectPayload(tournament, tid, roundNum, letter);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_delete') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_wizard_delete_confirm').setLabel('Yes, delete it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_wizard_delete_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: `⚠️ Delete **${store.tournament.name}** and all groups/registrations? This can't be undone.`,
      embeds: [],
      components: [row],
    });
  }

  if (id === 'tourney_wizard_delete_confirm') {
    const tournament = store.tournament;
    // Round 1 groups live on tournament.groups; Round 2+ groups live under
    // tournament.rounds[n].groups — both need their channels/roles cleaned
    // up, plus each round's own category and the shared Round 1 category.
    const groups = tournament ? Object.values(tournament.groups) : [];
    const categoryIds = new Set();
    if (tournament && tournament.rounds) {
      for (const round of Object.values(tournament.rounds)) {
        groups.push(...Object.values(round.groups || {}));
        if (round.categoryId) categoryIds.add(round.categoryId);
      }
    }
    if (store.settings && store.settings.tournamentGroupChannelsCategoryId) {
      categoryIds.add(store.settings.tournamentGroupChannelsCategoryId);
    }

    let cleanupFailures = 0;

    for (const group of groups) {
      if (group.channelId) {
        const channel = interaction.guild.channels.cache.get(group.channelId);
        if (channel) {
          await channel.delete('Tournament deleted').catch(() => { cleanupFailures++; });
        }
      }
      if (group.roleId) {
        const role = interaction.guild.roles.cache.get(group.roleId);
        if (role) {
          await role.delete('Tournament deleted').catch(() => { cleanupFailures++; });
        }
      }
    }

    // Categories are deleted last, after every channel inside them is gone
    // (Discord won't delete a non-empty category's children automatically).
    for (const categoryId of categoryIds) {
      const category = interaction.guild.channels.cache.get(categoryId);
      if (category) {
        await category.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }
    if (store.settings && store.settings.tournamentGroupChannelsCategoryId) {
      delete store.settings.tournamentGroupChannelsCategoryId;
    }

    if (tournament && tournament.winnerRoleId) {
      const winnerRole = interaction.guild.roles.cache.get(tournament.winnerRoleId);
      if (winnerRole) {
        await winnerRole.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }

    store.tournament = null;
    saveGuildStore(interaction.guildId, store);
    return interaction.update({
      content: cleanupFailures
        ? `🗑️ Tournament deleted. ⚠️ ${cleanupFailures} group channel/role(s) couldn't be removed automatically — check the bot's permissions.`
        : '🗑️ Tournament deleted, along with all group channels, categories, and roles.',
      ...buildTournamentListPayload(interaction.guildId),
    });
  }

  if (id === 'tourney_wizard_delete_cancel') {
    const payload = buildTournamentWizardPayload(store);
    return interaction.update({ content: '', ...payload });
  }
}

// ---------------------------------------------------------------------------
// Modal submits
// ---------------------------------------------------------------------------
async function handleTournamentCreateModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);

  const name = interaction.fields.getTextInputValue('name').trim();
  store.tournament = {
    name, open: false, groups: {}, qualified: [], bannedTeams: [],
    slotManagerChannelId: null, confirmChannelId: null,
    requiredMentions: 4, teamsPerGroup: DEFAULT_GROUP_CAPACITY, totalSlots: null,
    rounds: {}, // rounds[2..maxRounds] = { groupSize, groups: {}, categoryId } — created lazily, see getRound(). maxRounds itself defaults via getMaxRounds() until Manage Rounds sets one.
  };
  saveGuildStore(interaction.guildId, store);

  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleAddGroupModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const letter = interaction.fields.getTextInputValue('letter').trim().toUpperCase();
  const capacityRaw = interaction.fields.getTextInputValue('capacity').trim();
  const capacity = parseInt(capacityRaw, 10);

  if (!GROUP_LETTERS.includes(letter)) {
    return interaction.reply({ content: `❌ Group number must be a whole number between 1 and ${MAX_GROUPS}.`, flags: MessageFlags.Ephemeral });
  }
  if (store.tournament.groups[letter]) {
    return interaction.reply({ content: `❌ Group **${letter}** already exists.`, flags: MessageFlags.Ephemeral });
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Capacity must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }

  store.tournament.groups[letter] = { capacity, teams: [] };
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
}

// Auto-creates as many groups as needed to cover `total` teams at `perGroup`
// capacity each, filling the next free letters in order (A, B, C...). The
// last group created absorbs whatever remainder is left over, so the
// capacities always add up to exactly `total` instead of over-provisioning.
async function handleAutoGroupsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const total = parseInt(interaction.fields.getTextInputValue('total').trim(), 10);
  const perGroup = parseInt(interaction.fields.getTextInputValue('per_group').trim(), 10);

  const result = computeAutoGroups(store.tournament, total, perGroup);
  if (result.error) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  const { createdLetters, groupsNeeded } = result;
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
  await interaction.channel.send(
    `⚙️ Auto-created **${groupsNeeded}** group(s) — ${createdLetters.join(', ')} — covering **${total}** teams at up to **${perGroup}** per group.`
  ).catch(() => {});
}

// Public team registration, step 1 — the team-name modal. This only
// validates + stages the team name; the actual slot assignment happens
// once the player has mentioned their 4 teammates and hit Confirm (see
// handleTourneyRegSelectPlayers / handleTourneyRegConfirm below).
async function handleRegisterTeamModalSubmit(interaction) {
  const tid = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];

  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (!tournament.open) {
    return interaction.reply({ content: '❌ Registration is currently closed.', flags: MessageFlags.Ephemeral });
  }

  const team = interaction.fields.getTextInputValue('team').trim();
  if (!team) {
    return interaction.reply({ content: '❌ Team name is required.', flags: MessageFlags.Ephemeral });
  }
  if (isBanned(tournament, team)) {
    return interaction.reply({ content: `❌ **${team}** is banned from registering.`, flags: MessageFlags.Ephemeral });
  }
  if (isDuplicateTeam(tournament, team)) {
    return interaction.reply({ content: `❌ A team named **${team}** is already registered.`, flags: MessageFlags.Ephemeral });
  }

  const requiredMentions = tournament.requiredMentions || 4;
  startRegPending(interaction.user.id, interaction.guildId, { team, tournamentId: tid });

  return interaction.reply({
    content: `Team name set to **${team}**. Now mention the **${requiredMentions} player${requiredMentions === 1 ? '' : 's'}** on your team:`,
    components: [buildMentionPlayersRow(requiredMentions)],
    flags: MessageFlags.Ephemeral,
  });
}

// Public team registration, step 2 — player mentions picked from the
// select menu shown after step 1. Just stages the pick and shows a
// review/confirm screen; nothing is saved to data.json yet.
async function handleTourneyRegSelectPlayers(interaction) {
  const pendingEntry = getRegPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.reply({ content: `❌ Your session expired or was interrupted. ${RESTART_HINT}`, flags: MessageFlags.Ephemeral });
  }

  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[pendingEntry.data.tournamentId];
  if (!tournament) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }

  const requiredMentions = tournament.requiredMentions || 4;

  // Bots can't be a playing member of a team lineup.
  const botPicked = interaction.users.find(u => u.bot);
  if (botPicked) {
    return interaction.update({
      content: `❌ ${botPicked} is a bot and can't be picked as a player. Mention ${requiredMentions} human player${requiredMentions === 1 ? '' : 's'} below:`,
      embeds: [],
      components: [buildMentionPlayersRow(requiredMentions)],
    });
  }

  // A player can only be on one team's lineup at a time in this tournament.
  const conflict = findTournamentLineupConflict(tournament, interaction.values);
  if (conflict) {
    return interaction.update({
      content: `❌ <@${conflict.conflictId}> is already registered as a player on **${conflict.team}** and can't be picked again. Mention a different lineup below:`,
      embeds: [],
      components: [buildMentionPlayersRow(requiredMentions)],
    });
  }

  updateRegPending(interaction.user.id, { selectedPlayerIds: interaction.values });
  const pending = getRegPending(interaction.user.id);

  return interaction.update({
    content: null,
    embeds: [buildTeamRegPreviewEmbed(pending.data)],
    components: [tourneyConfirmRow()],
  });
}

// ---------------------------------------------------------------------------
// Automatic group/slot assignment for public tournament registration —
// mirrors how scrims auto-assign slots into fixed-size groups, but starting
// at slot 1 (no reserved slots) and capped at MAX_GROUPS groups total.
// ---------------------------------------------------------------------------
function totalRegisteredTeams(tournament) {
  return Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
}

// Non-mutating check for whether registration has hit capacity — either
// the admin's overall totalSlots cap, or every one of the MAX_GROUPS
// groups being completely full. Deliberately doesn't reuse
// autoAssignGroup() for this, since that function creates a new empty
// group as a side effect when it finds room; calling it just to "peek"
// would spuriously create groups.
function isRegistrationFull(tournament) {
  if (tournament.totalSlots && totalRegisteredTeams(tournament) >= tournament.totalSlots) {
    return true;
  }
  const capacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const group = tournament.groups[String(i)];
    if (!group || group.teams.length < group.capacity) return false;
  }
  return true;
}

// Finds (auto-creating if needed) the group the next team should land in:
// the first not-yet-full existing group, or the next new group number if
// every existing group is full. Returns null once the tournament's overall
// totalSlots cap or the MAX_GROUPS safety cap has been reached — at which
// point every group must be completely full before registration can grow.
function autoAssignGroup(tournament) {
  if (tournament.totalSlots && totalRegisteredTeams(tournament) >= tournament.totalSlots) {
    return null;
  }
  const capacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const key = String(i);
    const group = tournament.groups[key];
    if (!group) {
      tournament.groups[key] = { capacity, teams: [] };
      return key;
    }
    if (group.teams.length < group.capacity) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Round 2+ — teams qualified out of a group (via that group's "Result"
// button) get funneled into the next round's groups the same way Round 1
// fills up: first not-yet-full group in that round, or the next new one,
// capped at that round's groupSize. Every round beyond 1 gets its own
// role + private channel per group, created the moment it's first needed —
// this is what lets rounds chain indefinitely (up to getMaxRounds) instead
// of stopping at a hardcoded Round 2.
// ---------------------------------------------------------------------------

// tournament.maxRounds caps how many rounds the "Result" button will chain
// through — defaults to 2 (Round 1 registration + one promotion round) for
// tournaments that haven't touched Manage Rounds' Max Rounds setting.
function getMaxRounds(tournament) {
  return Math.min(Math.max(tournament.maxRounds || 2, 1), MAX_ROUND);
}

function findRoundEntry(tournament, roundNum, ownerId) {
  const groups = getRoundGroups(tournament, roundNum);
  for (const letter of Object.keys(groups)) {
    const g = groups[letter];
    const idx = g.teams.findIndex(t => t.ownerId === ownerId);
    if (idx !== -1) return { letter, group: g, idx, team: g.teams[idx] };
  }
  return null;
}

function autoAssignRoundGroup(tournament, roundNum) {
  const groups = getRoundGroups(tournament, roundNum);
  const capacity = roundNum <= 1
    ? (tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY)
    : (getRound(tournament, roundNum).groupSize || DEFAULT_GROUP_CAPACITY);
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const key = String(i);
    const group = groups[key];
    if (!group) {
      groups[key] = { capacity, teams: [] };
      return key;
    }
    if (group.teams.length < group.capacity) {
      return key;
    }
  }
  return null;
}

// Creates (once per group) a role + private channel together for a Round
// 2+ group, the moment a team is promoted via "Result" — unlike Round 1
// registration, promotion is an admin action, not self-service, so there's
// no need to hold the channel back separately from the role here. Each
// round gets its own category, so Round 2's channels never mix with
// Round 3's, etc. Reuses ensureGroupRole so the role side is identical to
// Round 1's group roles.
async function ensureRoundGroupChannelAndRole(interaction, store, tournament, roundNum, groupKey) {
  const round = getRound(tournament, roundNum);
  const group = round.groups[groupKey];
  const botMember = interaction.guild.members.me;

  // Names come from Manage Rounds -> Round N (Channel / Role / Category
  // Name). Unset fields fall back to the original built-in names, so
  // tournaments that never touch those settings behave exactly as before.
  const naming = getRoundNaming(tournament, roundNum);
  const roleName = applyRoundNameFormat(naming.roleFormat, { roundNum, groupKey, separator: ' ' }).slice(0, 100);

  const role = await ensureGroupRole(
    interaction, store, group,
    roleName,
    `Auto-created for Round ${roundNum} Group ${groupKey}`,
  );

  if (!group.channelId || !interaction.guild.channels.cache.has(group.channelId)) {
    if (!botMember.permissions.has('ManageChannels')) {
      console.error(`[tournament-round-channel] Bot is missing the "Manage Channels" permission in guild ${interaction.guildId}.`);
    } else if (interaction.guild.channels.cache.size >= MAX_GUILD_CHANNELS - SAFETY_MARGIN) {
      console.error(`[tournament-round-channel] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_CHANNELS}-channel cap — skipping auto-create for Round ${roundNum} Group ${groupKey}.`);
    } else {
      try {
        let category = round.categoryId ? interaction.guild.channels.cache.get(round.categoryId) : null;

        if (!category) {
          const categoryName = resolveRoundCategoryName(naming.categoryName, roundNum);
          // Reuse a category that already has this exact name (case-
          // insensitive) instead of spawning a duplicate — also lets two
          // rounds deliberately share one category by giving it one name.
          category = interaction.guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
          );
          if (!category) {
            category = await interaction.guild.channels.create({
              name: categoryName,
              type: ChannelType.GuildCategory,
              reason: `Auto-created to hold per-group Round ${roundNum} tournament channels`,
            });
          }
          round.categoryId = category.id;
        }

        // Private to this one group's role only — same lockdown as every
        // other tournament group channel, no tournament-wide role added.
        const overwrites = [{ id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
        if (role) {
          overwrites.push({
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
          });
        }

        const channel = await interaction.guild.channels.create({
          name: applyRoundNameFormat(naming.channelFormat, { roundNum, groupKey, separator: '-' }).toLowerCase().slice(0, 100),
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: overwrites,
          reason: `Auto-created for Round ${roundNum} Group ${groupKey}`,
        });

        group.channelId = channel.id;
        saveGuildStore(interaction.guildId, store);
        await channel.send(buildTournamentGroupAdminPanelPayload(tournament, roundNum, groupKey)).catch(() => {});
      } catch (err) {
        console.error(`[tournament-round-channel] Failed to auto-create channel for Round ${roundNum} Group ${groupKey} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
  }

  return role;
}

// Strips a team's access to a round's group (role + group role) and
// removes it from whichever group it was sitting in for that round —
// then keeps walking forward through every later round too, in case the
// team had already been promoted further (e.g. punished after reaching
// Round 3). Used when a team is un-qualified (Result re-run without
// them), punished, or self-service cancelled.
async function removeTeamFromRoundOnward(interaction, store, tournament, team, fromRound) {
  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = fromRound; roundNum <= maxRounds; roundNum++) {
    const entry = findRoundEntry(tournament, roundNum, team.ownerId);
    if (!entry) continue;

    const { group, idx } = entry;
    group.teams.splice(idx, 1);
    saveGuildStore(interaction.guildId, store);

    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (group.roleId) await member.roles.remove(group.roleId).catch(() => {});
    }
  }
}

// Public team registration, step 3 — "Confirm Registration" pressed on the
// review screen. This is where the team actually gets a slot and the
// success role is handed out.
async function handleTourneyRegConfirm(interaction) {
  const pendingEntry = getRegPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.update({ content: `❌ Your session expired or was interrupted. ${RESTART_HINT}`, embeds: [], components: [] });
  }

  const { team, selectedPlayerIds = [], tournamentId } = pendingEntry.data;
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tournamentId];

  if (!tournament) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }
  if (!tournament.open) {
    clearRegPending(interaction.user.id);
    const content = tournament.closedReason === 'full'
      ? '🔒 Registration is closed — all slots are full.'
      : '❌ Registration is currently closed.';
    return interaction.update({ content, embeds: [], components: [] });
  }
  if (isBanned(tournament, team) || isDuplicateTeam(tournament, team)) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: `❌ **${team}** can no longer be registered. ${RESTART_HINT}`, embeds: [], components: [] });
  }

  // Belt-and-suspenders: re-check for a lineup conflict here too, in case
  // another team grabbed one of these players in the gap between the
  // player-select step and this confirm tap.
  const conflict = findTournamentLineupConflict(tournament, selectedPlayerIds);
  if (conflict) {
    clearRegPending(interaction.user.id);
    return interaction.update({
      content: `❌ <@${conflict.conflictId}> just got locked into **${conflict.team}** by someone else. ${RESTART_HINT}`,
      embeds: [],
      components: [],
    });
  }

  const letter = autoAssignGroup(tournament);

  if (!letter) {
    // Someone else's registration filled the last slot in the moments
    // between this player opening the form and hitting Confirm — make sure
    // the tournament is marked closed too, not just this one submission.
    if (tournament.open) {
      tournament.open = false;
      tournament.closedReason = 'full';
      saveGuildStore(interaction.guildId, store);
      await refreshRegisterPanel(interaction.guild, tournament);
    }
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '🔒 Registration is closed — all slots are full.', embeds: [], components: [] });
  }

  tournament.groups[letter].teams.push({
    team,
    playerIds: selectedPlayerIds,
    players: selectedPlayerIds.map(id => `<@${id}>`),
    ownerId: interaction.user.id,
  });

  // This team just took the last open slot — close registration
  // automatically so the next player to click Register Team sees a clear
  // "full" message immediately instead of filling out the whole form
  // first and getting rejected at the end.
  let justClosed = false;
  if (isRegistrationFull(tournament)) {
    tournament.open = false;
    tournament.closedReason = 'full';
    justClosed = true;
  }

  saveGuildStore(interaction.guildId, store);
  clearRegPending(interaction.user.id);

  const slotNumber = tournament.groups[letter].teams.length;

  // Registration only grants this team's own group role — it does NOT
  // create or reveal the group's channel. Channels stay hidden from
  // players until an admin explicitly runs Create Channels → Auto
  // Channels; at that point whoever holds a group's role (from
  // registering earlier) instantly sees just that one group's channel,
  // since the channel's permission overwrite is keyed to the same role.
  // A team in Group 1 never gets any role that lets it see Group 2's
  // channel — or Group 2's, before it even exists.
  //
  // Only the player who actually submitted the registration (the "team
  // owner") gets the role — teammates just mentioned in the form are
  // registered as part of the roster, but they aren't the one who ran
  // Register Team, so they don't get channel access from this alone.
  let roleWarning = null;
  const groupRole = await ensureGroupRole(
    interaction, store, tournament.groups[letter],
    applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: letter, separator: ' ' }),
    `Auto-created for Group ${letter} tournament registration`,
  ).catch(() => null);
  if (groupRole) {
    const owner = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (owner) {
      await owner.roles.add(groupRole.id).catch(err => {
        console.error(`[tournament-group-role] Failed to add role ${groupRole.id} to ${interaction.user.id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        roleWarning = `\n\n⚠️ Couldn't give you the Group ${letter} role — ask an admin to check my **Manage Roles** permission and that my role sits above <@&${groupRole.id}>.`;
      });
    } else {
      roleWarning = `\n\n⚠️ Couldn't give you the Group ${letter} role — ask an admin to check my **Manage Roles** permission and that my role sits above <@&${groupRole.id}>.`;
    }
  } else {
    console.warn(`[tournament-group-role] Couldn't create/find a role for Group ${letter} in guild ${interaction.guildId} — check my Manage Roles permission.`);
  }

  if (tournament.confirmChannelId) {
    const confirmChannel = interaction.guild.channels.cache.get(tournament.confirmChannelId);
    if (confirmChannel) {
      const lineup = selectedPlayerIds.map(id => `<@${id}>`).join(' ');
      await confirmChannel.send(`✅ **${team}** (${interaction.user}) registered into **Group ${letter}**, Slot **${slotNumber}**.\n👥 ${lineup}`).catch(() => {});
      if (justClosed) {
        await confirmChannel.send(`🔒 Registration for **${tournament.name}** is now closed — all slots are full.`).catch(() => {});
      }
    }
  }

  // Reflect the new slot count (and closed status, if this was the last
  // one) on the public panel right away rather than waiting for someone
  // to re-post it.
  await refreshRegisterPanel(interaction.guild, tournament);

  return interaction.update({
    content: null,
    embeds: [
      new EmbedBuilder()
        .setTitle('🎯 Registration Complete!')
        .setColor(0x57F287)
        .setDescription(
          `**Team** — ${team}\n` +
          `**Group** — ${letter}\n` +
          `**Slot** — ${slotNumber}\n` +
          `**Players** — ${selectedPlayerIds.map(id => `<@${id}>`).join(' ')}\n\n` +
          (roleWarning || '')
        ),
    ],
    components: [],
  });

}

// "Cancel" pressed on the review screen.
async function handleTourneyRegCancel(interaction) {
  clearRegPending(interaction.user.id);
  return interaction.update({
    content: `❌ Registration cancelled — nothing was saved. ${RESTART_HINT}`,
    embeds: [],
    components: [],
  });
}

async function handleRequiredMentionsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    return interaction.reply({ content: '❌ Required Mentions must be a whole number between 1 and 4.', flags: MessageFlags.Ephemeral });
  }
  store.tournament.requiredMentions = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleTeamsPerGroupModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Teams per Group must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.teamsPerGroup = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleTotalSlotsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_SLOTS) {
    return interaction.reply({ content: `❌ Total Slots must be a whole number between 1 and ${MAX_TOTAL_SLOTS}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.totalSlots = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleCreateConfirmChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  store.tournament.confirmChannelId = interaction.channels.first().id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

// ---------------------------------------------------------------------------
// Manage Rounds — set how many rounds the tournament chains through
// (Max Rounds), and configure every round 1..maxRounds: Channel Name, Role
// Name and Category Name (plus group size for Round 2+; Round 1's size is
// the tournament's own Teams-per-Group setting). Round 2+ groups are
// created lazily the first time a team is promoted into them (each gets
// its own auto-created role, same as Round 1's groups — there's no single
// shared "round role" to set).
// ---------------------------------------------------------------------------
function getRound(tournament, roundNum) {
  if (!tournament.rounds) tournament.rounds = {};
  if (!tournament.rounds[roundNum]) {
    tournament.rounds[roundNum] = { groupSize: DEFAULT_GROUP_CAPACITY, groups: {}, categoryId: null };
  }
  return tournament.rounds[roundNum];
}

// tournament.groups IS round 1 — this just picks the right container so
// the rest of the round-aware code can treat every round the same way.
function getRoundGroups(tournament, roundNum) {
  return roundNum <= 1 ? tournament.groups : getRound(tournament, roundNum).groups;
}

// ---- Per-round naming (Channel / Role / Category) -----------------------
// Every round 1..MAX_ROUND can carry its own channelFormat / roleFormat /
// categoryName under tournament.rounds[n]. Unset fields fall back to the
// defaults below (Round 2+ defaults match the names the bot always used, so
// existing tournaments are unaffected). Tokens: {round} = round number,
// {number} / {letter} = the group's number (groups are keyed 1, 2, 3...).
const ROUND_NAMING_FIELDS = {
  channel:  { key: 'channelFormat', title: 'Channel Name',  label: 'Channel name (empty = reset to default)',  maxLength: 80 },
  role:     { key: 'roleFormat',    title: 'Role Name',     label: 'Role name (empty = reset to default)',     maxLength: 80 },
  category: { key: 'categoryName',  title: 'Category Name', label: 'Category name (empty = reset to default)', maxLength: 100 },
};

function defaultRoundNaming(roundNum) {
  if (roundNum <= 1) {
    // Round 1's channel + category are normally chosen in Create Channel,
    // so they have no built-in default — only the role does.
    return { channelFormat: null, roleFormat: 'Tournament Group {letter}', categoryName: null };
  }
  return {
    channelFormat: 'round{round}-group-{number}',
    roleFormat: 'Round {round} - Group {number}',
    categoryName: '🏆 Round {round} Groups',
  };
}

function getRoundNaming(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  const defaults = defaultRoundNaming(roundNum);
  return {
    channelFormat: saved.channelFormat || defaults.channelFormat,
    roleFormat: saved.roleFormat || defaults.roleFormat,
    categoryName: saved.categoryName || defaults.categoryName,
    isCustom: {
      channel: Boolean(saved.channelFormat),
      role: Boolean(saved.roleFormat),
      category: Boolean(saved.categoryName),
    },
  };
}

// Fills {round}/{number}/{letter}. If the format has neither {number} nor
// {letter}, the group key is appended (with `separator`) so every group's
// name stays unique.
function applyRoundNameFormat(format, { roundNum, groupKey, separator }) {
  const hasGroupToken = /\{(letter|number)\}/i.test(format);
  let out = format.replace(/\{round\}/gi, String(roundNum)).replace(/\{(letter|number)\}/gi, String(groupKey));
  if (!hasGroupToken) out = `${out}${separator}${groupKey}`;
  return out;
}

function resolveRoundCategoryName(format, roundNum) {
  return format.replace(/\{round\}/gi, String(roundNum)).slice(0, 100);
}

function buildRoundListPayload(tournament) {
  const maxRounds = getMaxRounds(tournament);
  const options = [];
  for (let n = 1; n <= maxRounds; n++) {
    if (n === 1) {
      const registered = Object.values(tournament.groups || {}).reduce((sum, g) => sum + g.teams.length, 0);
      options.push({
        label: 'Round 1',
        description: `${tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY} per group · ${registered} team${registered === 1 ? '' : 's'} registered`,
        value: '1',
      });
      continue;
    }
    const round = tournament.rounds && tournament.rounds[n];
    const teamCount = round ? Object.values(round.groups || {}).reduce((sum, g) => sum + g.teams.length, 0) : 0;
    options.push({
      label: `Round ${n}`,
      description: `${round?.groupSize || DEFAULT_GROUP_CAPACITY} per group · ${teamCount} team${teamCount === 1 ? '' : 's'} promoted`,
      value: String(n),
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 Manage Rounds')
    .setColor(0x5865F2)
    .addFields({ name: 'Max Rounds', value: String(maxRounds) })
    .setDescription(
      `Rounds chain off each other up to Max Rounds (currently **${maxRounds}**, up to ${MAX_ROUND} max) — clicking **Result** in a group's channel promotes its picked teams into the next round, filling that round's groups in order, until Max Rounds is reached. ` +
      'Pick a round below to set its **Channel Name**, **Role Name** and **Category Name** (and group size for Round 2+). Anything you skip uses a sensible default.'
    );

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_round_config_maxrounds').setLabel('Set Max Rounds').setEmoji('🔢').setStyle(ButtonStyle.Primary),
  )];

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_round_config_select')
    .setPlaceholder('Pick a round to configure')
    .addOptions(options);
  components.push(new ActionRowBuilder().addComponents(select));

  return { embeds: [embed], components };
}

function buildRoundDetailPayload(tournament, roundNum) {
  const naming = getRoundNaming(tournament, roundNum);
  const show = (value, isCustom) => {
    if (!value) return '`Not set`';
    return `\`${value}\`${isCustom ? '' : ' (default)'}`;
  };
  const groupSize = roundNum <= 1
    ? `${tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY} (set in Edit Settings → Teams per Group)`
    : String(getRound(tournament, roundNum).groupSize || DEFAULT_GROUP_CAPACITY);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Round ${roundNum} Settings`)
    .setColor(0x5865F2)
    .setDescription(
      'Tokens: `{round}` = round number, `{number}` = group number (1, 2, 3...). ' +
      'Changes apply to channels and roles created **from now on** — ones that already exist keep their names ' +
      '(except the category, which is renamed if it already exists). Submit an empty box to reset a field.'
    )
    .addFields(
      { name: 'Group Size', value: groupSize },
      { name: 'Channel Name', value: show(naming.channelFormat, naming.isCustom.channel) },
      { name: 'Role Name', value: show(naming.roleFormat, naming.isCustom.role) },
      { name: 'Category Name', value: show(naming.categoryName, naming.isCustom.category) },
    );

  const namingRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:channel:${roundNum}`).setLabel('Channel Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:role:${roundNum}`).setLabel('Role Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:category:${roundNum}`).setLabel('Category Name').setStyle(ButtonStyle.Primary),
  );

  const navRow = new ActionRowBuilder();
  if (roundNum >= 2) {
    navRow.addComponents(new ButtonBuilder().setCustomId(`tourney_round_config_size:${roundNum}`).setLabel('Set Group Size').setStyle(ButtonStyle.Secondary));
  }
  navRow.addComponents(new ButtonBuilder().setCustomId('tourney_round_config_back').setLabel('Back').setStyle(ButtonStyle.Secondary));

  return { embeds: [embed], components: [namingRow, navRow] };
}

function buildRoundNamingModal(tournament, roundNum, field) {
  const meta = ROUND_NAMING_FIELDS[field];
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  const defaults = defaultRoundNaming(roundNum);
  const fallbackPlaceholders = { channel: 'Group {number}', role: 'Tournament Group {letter}', category: '🥇 Tournament Groups' };

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(meta.label)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(meta.maxLength)
    .setPlaceholder((defaults[meta.key] || fallbackPlaceholders[field]).slice(0, 100));
  if (saved[meta.key]) input.setValue(saved[meta.key]);

  return new ModalBuilder()
    .setCustomId(`tourney_round_naming_modal:${field}:${roundNum}`)
    .setTitle(`Round ${roundNum} ${meta.title}`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildRoundSizeModal(round, roundNum) {
  const input = new TextInputBuilder().setCustomId('value').setLabel(`Round ${roundNum} Group Size`).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(4).setPlaceholder('e.g. 12');
  input.setValue(String(round.groupSize || DEFAULT_GROUP_CAPACITY));
  return new ModalBuilder().setCustomId(`tourney_round_size_modal:${roundNum}`).setTitle(`Round ${roundNum} Group Size`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildMaxRoundsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel(`Max Rounds (1-${MAX_ROUND})`).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(2).setPlaceholder('e.g. 3');
  input.setValue(String(getMaxRounds(tournament)));
  return new ModalBuilder().setCustomId('tourney_round_maxrounds_modal').setTitle('Set Max Rounds')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function handleRoundConfigSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }
  const roundNum = parseInt(interaction.values[0], 10);
  if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
    return interaction.reply({ content: '❌ Unknown round.', flags: MessageFlags.Ephemeral });
  }
  await interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

// Dispatches the buttons under Manage Rounds — Set Max Rounds (modal),
// Channel / Role / Category Name for a specific round (modal), Set Group
// Size for a specific round (modal), and Back to the round list.
async function handleRoundConfigButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const { customId } = interaction;

  if (customId === 'tourney_round_config_maxrounds') {
    return interaction.showModal(buildMaxRoundsModal(store.tournament));
  }

  if (customId.startsWith('tourney_round_config_naming:')) {
    const [, field, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    if (!ROUND_NAMING_FIELDS[field] || !Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
      return interaction.reply({ content: '❌ Unknown round setting.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildRoundNamingModal(store.tournament, roundNum, field));
  }

  if (customId.startsWith('tourney_round_config_size:')) {
    const [, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    return interaction.showModal(buildRoundSizeModal(getRound(store.tournament, roundNum), roundNum));
  }

  if (customId === 'tourney_round_config_back') {
    return interaction.update({ content: '', ...buildRoundListPayload(store.tournament) });
  }
}

async function handleRoundNamingModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, field, roundNumStr] = interaction.customId.split(':');
  const roundNum = parseInt(roundNumStr, 10);
  const meta = ROUND_NAMING_FIELDS[field];
  if (!meta || !Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
    return interaction.reply({ content: '❌ Unknown round setting.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  // Renaming an existing category can be slow (Discord rate-limits channel
  // renames), so acknowledge first and edit the panel once it's done.
  await interaction.deferUpdate();

  const value = interaction.fields.getTextInputValue('value').trim();
  const round = getRound(store.tournament, roundNum);
  if (value) round[meta.key] = value;
  else delete round[meta.key];
  saveGuildStore(interaction.guildId, store);

  // The category is the one thing that's already a single shared object per
  // round, so keep it in sync if it exists. Channels/roles already created
  // are left alone.
  if (field === 'category' && roundNum >= 2 && round.categoryId) {
    const category = interaction.guild.channels.cache.get(round.categoryId);
    if (category) {
      const newName = resolveRoundCategoryName(getRoundNaming(store.tournament, roundNum).categoryName, roundNum);
      if (category.name !== newName) {
        await category.setName(newName, `Round ${roundNum} category renamed via Manage Rounds`).catch(() => {});
      }
    }
  }

  await interaction.editReply({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

async function handleRoundSizeModalSubmit(interaction) {
  const [, roundNumStr] = interaction.customId.split(':');
  const roundNum = parseInt(roundNumStr, 10);
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Group Size must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }
  getRound(store.tournament, roundNum).groupSize = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

async function handleMaxRoundsModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ROUND) {
    return interaction.reply({ content: `❌ Max Rounds must be a whole number between 1 and ${MAX_ROUND}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.maxRounds = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildRoundListPayload(store.tournament) });
}

// "Create Channel" (manual) — Channel Format / Category Name modal
// submissions. Both just save into the in-memory pending state (see
// pendingManualChannelCreation below) and re-render the panel; actual
// creation happens on the "Create Channels" button once both are set.
async function handleManualChannelsFormatModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const value = interaction.fields.getTextInputValue('value').trim();
  if (!value) {
    return interaction.reply({ content: '❌ Channel format can\'t be empty.', flags: MessageFlags.Ephemeral });
  }
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { channelFormat: value });
  return interaction.update({ ...buildManualChannelCreationPayload(data) });
}

async function handleManualChannelsCategoryNameModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const value = interaction.fields.getTextInputValue('value').trim();
  if (!value) {
    return interaction.reply({ content: '❌ Category name can\'t be empty.', flags: MessageFlags.Ephemeral });
  }
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { categoryName: value });
  return interaction.update({ ...buildManualChannelCreationPayload(data) });
}

async function handleManualChannelsRoleNameModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const value = interaction.fields.getTextInputValue('value').trim();
  if (!value) {
    return interaction.reply({ content: '❌ Role name can\'t be empty.', flags: MessageFlags.Ephemeral });
  }
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { roleFormat: value });
  return interaction.update({ ...buildManualChannelCreationPayload(data) });
}


async function handleEditSettingsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const name = interaction.fields.getTextInputValue('name').trim();
  if (!name) {
    return interaction.reply({ content: '❌ Name is required.', flags: MessageFlags.Ephemeral });
  }

  store.tournament.name = name;
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
}

// Toggling the same team name again flips it back — ban if not banned,
// unban if already banned. Banning also evicts them from whatever group
// they're currently sitting in, since a banned team shouldn't keep a slot.
async function handleBanUnbanModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const teamRaw = interaction.fields.getTextInputValue('team').trim();
  if (!teamRaw) {
    return interaction.reply({ content: '❌ Team name is required.', flags: MessageFlags.Ephemeral });
  }
  const teamKey = teamRaw.toLowerCase();

  if (!tournament.bannedTeams) tournament.bannedTeams = [];
  const idx = tournament.bannedTeams.indexOf(teamKey);

  if (idx === -1) {
    tournament.bannedTeams.push(teamKey);
    let removedFrom = null;
    for (const [letter, group] of Object.entries(tournament.groups)) {
      const before = group.teams.length;
      group.teams = group.teams.filter(t => t.team.toLowerCase() !== teamKey);
      if (group.teams.length !== before) removedFrom = letter;
    }
    tournament.qualified = tournament.qualified.filter(name => name.toLowerCase() !== teamKey);
    saveGuildStore(interaction.guildId, store);
    return interaction.reply({
      content: `🔨 **${teamRaw}** is now banned from registering.${removedFrom ? ` Removed from Group ${removedFrom}.` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  tournament.bannedTeams.splice(idx, 1);
  saveGuildStore(interaction.guildId, store);
  return interaction.reply({ content: `✅ **${teamRaw}** has been unbanned and can register again.`, flags: MessageFlags.Ephemeral });
}

// Admin version of team registration — picks the exact group instead of
// auto-assigning, and works even while registration is closed. The player
// to credit as the team's owner (and to hand the group role to) was
// already picked in the UserSelectMenu step before this modal ever opened,
// same for the group itself — both travel in via the modal's customId.
async function handleManualAddSlotModalSubmit(interaction) {
  const [, userId, letter] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const team = interaction.fields.getTextInputValue('team').trim();
  const player1 = interaction.fields.getTextInputValue('player1').trim();
  const player2 = interaction.fields.getTextInputValue('player2').trim();
  const players34 = interaction.fields.getTextInputValue('players34').trim();

  const group = tournament.groups[letter];
  if (!group) {
    const existing = Object.keys(tournament.groups).join(', ') || 'none yet';
    return interaction.reply({ content: `❌ Group **${letter}** doesn't exist. Current groups: ${existing}.`, flags: MessageFlags.Ephemeral });
  }
  if (!team) {
    return interaction.reply({ content: '❌ Team name is required.', flags: MessageFlags.Ephemeral });
  }
  if (isBanned(tournament, team)) {
    return interaction.reply({ content: `❌ **${team}** is banned from registering.`, flags: MessageFlags.Ephemeral });
  }
  if (isDuplicateTeam(tournament, team)) {
    return interaction.reply({ content: `❌ A team named **${team}** is already registered.`, flags: MessageFlags.Ephemeral });
  }
  if (group.teams.length >= group.capacity) {
    return interaction.reply({ content: `❌ Group **${letter}** is already full (${group.capacity}/${group.capacity}).`, flags: MessageFlags.Ephemeral });
  }

  const players = [player1, player2, ...players34.split(',').map(s => s.trim())].filter(Boolean);
  group.teams.push({ team, players, playerIds: [userId], ownerId: userId });
  saveGuildStore(interaction.guildId, store);

  // Mirrors self-registration: give the selected player just this group's
  // role (auto-creating it first if it doesn't exist yet) — that's what
  // reveals the group's channel to them once channels are created.
  let roleWarning = '';
  const groupRole = await ensureGroupRole(
    interaction, store, group,
    applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: letter, separator: ' ' }),
    `Manually added to Group ${letter} by ${interaction.user.tag}`,
  ).catch(() => null);
  if (groupRole) {
    const member = interaction.guild.members.cache.get(userId)
      ?? await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member.roles.add(groupRole.id).catch(err => {
        console.error(`[tournament-group-role] Failed to add role ${groupRole.id} to ${userId} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        roleWarning = `\n\n⚠️ Couldn't give <@${userId}> the Group ${letter} role — check my **Manage Roles** permission and that my role sits above <@&${groupRole.id}>.`;
      });
    } else {
      roleWarning = `\n\n⚠️ Couldn't find <@${userId}> in this server to give them the Group ${letter} role.`;
    }
  } else {
    roleWarning = `\n\n⚠️ Couldn't create/find a role for Group ${letter} — check my **Manage Roles** permission.`;
  }

  return interaction.reply({
    content: `✅ **${team}** added to **Group ${letter}**, Slot **${group.teams.length}** — <@${userId}> now has the group role.${roleWarning}`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// Qualify flow
// ---------------------------------------------------------------------------
function buildQualifySelectPayload(tournament, tid, roundNum, letter) {
  if (!letter) {
    return { error: "❌ Couldn't tell which group to qualify." };
  }

  const groups = getRoundGroups(tournament, roundNum);
  const label = roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
  const group = groups[letter];
  if (!group) {
    const existing = Object.keys(groups).join(', ') || 'none yet';
    return { error: `❌ ${label} doesn't exist. Current groups: ${existing}.` };
  }
  if (!group.teams.length) {
    return { error: `❌ ${label} has no registered teams yet.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ ${label} has ${group.teams.length} teams — Discord select menus cap at 25 options, so this group can't be shown as one list.` };
  }

  const alreadyQualified = new Set(tournament.qualified);
  const maxRounds = getMaxRounds(tournament);
  const isFinalRound = roundNum >= maxRounds;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`qualify_select_teams:${tid}:${roundNum}:${letter}`)
    .setPlaceholder(isFinalRound ? `Select the tournament winner from ${label}` : `Select qualifying teams from ${label}`)
    .setMinValues(0)
    .setMaxValues(isFinalRound ? 1 : group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({
      label: t.team.slice(0, 100),
      value: String(idx),
      default: isFinalRound ? tournament.winnerTeam === t.team : alreadyQualified.has(t.team),
    })));

  const embed = new EmbedBuilder()
    .setTitle(isFinalRound ? `🏆 Pick the Winner — ${label}` : `✅ Qualify Teams — ${label}`)
    .setColor(0x5865F2)
    .setDescription(
      isFinalRound
        ? `Select the **one** team that wins the tournament. They'll receive the **${tournament.name} Winner** role — this is the final round, so no one is promoted further.`
        : `Select every team from this group that qualifies, then confirm — they'll be promoted into Round ${roundNum + 1}. Already-qualified teams are pre-checked.`
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// Picker shown after clicking "Qualify" — pick which group, then hand off
// to the existing per-group team picker (buildQualifySelectPayload).
function buildQualifyGroupSelectPayload(tournament) {
  const letters = Object.keys(tournament.groups);
  if (!letters.length) {
    return { error: '❌ No groups exist yet — add one first.' };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_qualify_group_select')
    .setPlaceholder('Select a group to qualify teams from')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(letters.map(letter => ({
      label: `Group ${letter}`,
      description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
      value: letter,
    })));

  const embed = new EmbedBuilder()
    .setTitle('✅ Qualify Teams')
    .setColor(0x5865F2)
    .setDescription('Pick a group, then choose which of its teams qualify.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleQualifyGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [letter] = interaction.values;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const payload = buildQualifySelectPayload(tournament, tournament.id, 1, letter);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleQualifySelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];

  if (!tournament || !group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  await interaction.deferUpdate();

  const selectedIdx = new Set(interaction.values.map(v => parseInt(v, 10)));
  const selectedTeams = group.teams.filter((t, idx) => selectedIdx.has(idx));
  const selectedNames = selectedTeams.map(t => t.team);
  const selectedOwnerIds = new Set(selectedTeams.map(t => t.ownerId));
  const label = roundNum > 1 ? `Round ${roundNum} Group ${letter}` : `Group ${letter}`;
  const maxRounds = getMaxRounds(tournament);
  const nextRound = roundNum + 1;

  // Re-running qualify on the same group cleanly replaces its previous
  // picks rather than piling up duplicates: drop every team from this
  // group out of the qualified list first, then add back only what's
  // selected now.
  const groupTeamNames = new Set(group.teams.map(t => t.team));
  tournament.qualified = tournament.qualified.filter(name => !groupTeamNames.has(name));
  tournament.qualified.push(...selectedNames);
  saveGuildStore(interaction.guildId, store);

  // Un-promote anyone from this group who was in the next round but isn't
  // selected this time (e.g. Result re-run with a smaller pick).
  if (nextRound <= maxRounds) {
    for (const t of group.teams) {
      if (!selectedOwnerIds.has(t.ownerId)) {
        await removeTeamFromRoundOnward(interaction, store, tournament, t, nextRound);
      }
    }
  }

  // Promote newly-qualified teams into the next round — first not-yet-full
  // group there, or the next new one, filling in order the same way
  // Round 1 registration does. Already-promoted teams (Result re-run with
  // the same picks) are left where they are. Nothing is promoted once
  // this round is the last one Manage Rounds is configured for — instead,
  // the (at most one) selected team is crowned the tournament winner.
  const promoted = [];
  const failed = [];
  let winnerLine = null;
  if (nextRound <= maxRounds) {
    for (const t of selectedTeams) {
      if (findRoundEntry(tournament, nextRound, t.ownerId)) continue;

      const nextLetter = autoAssignRoundGroup(tournament, nextRound);
      if (!nextLetter) { failed.push(t.team); continue; }
      getRoundGroups(tournament, nextRound)[nextLetter].teams.push(t);
      saveGuildStore(interaction.guildId, store);

      const nextRole = await ensureRoundGroupChannelAndRole(interaction, store, tournament, nextRound, nextLetter).catch(() => null);

      const targets = new Set([t.ownerId, ...(t.playerIds || [])].filter(Boolean));
      for (const userId of targets) {
        const member = interaction.guild.members.cache.get(userId)
          ?? await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) continue;
        if (nextRole) await member.roles.add(nextRole.id).catch(() => {});
      }
      promoted.push(`**${t.team}** → Round ${nextRound} Group ${nextLetter}`);
    }
  } else {
    // Final round: the select menu caps picks at 1, so selectedTeams has
    // at most one entry. Swap the winner role off the previous pick (if
    // Result is re-run with a different team) and onto the new one — no
    // other team on this round gets any role, since there's no next round.
    const winnerTeam = selectedTeams[0] || null;
    const previousWinnerName = tournament.winnerTeam;

    if (previousWinnerName && previousWinnerName !== (winnerTeam ? winnerTeam.team : null) && tournament.winnerRoleId) {
      const prevTeam = group.teams.find(gt => gt.team === previousWinnerName);
      if (prevTeam) {
        const prevTargets = new Set([prevTeam.ownerId, ...(prevTeam.playerIds || [])].filter(Boolean));
        for (const userId of prevTargets) {
          const member = interaction.guild.members.cache.get(userId)
            ?? await interaction.guild.members.fetch(userId).catch(() => null);
          if (member) await member.roles.remove(tournament.winnerRoleId).catch(() => {});
        }
      }
    }

    if (winnerTeam) {
      const winnerRole = await ensureWinnerRole(interaction, store, tournament).catch(() => null);
      tournament.winnerTeam = winnerTeam.team;
      saveGuildStore(interaction.guildId, store);

      if (winnerRole) {
        const targets = new Set([winnerTeam.ownerId, ...(winnerTeam.playerIds || [])].filter(Boolean));
        for (const userId of targets) {
          const member = interaction.guild.members.cache.get(userId)
            ?? await interaction.guild.members.fetch(userId).catch(() => null);
          if (member) await member.roles.add(winnerRole.id).catch(() => {});
        }
      }
      winnerLine = `🏆 **${winnerTeam.team}** is crowned the tournament winner${winnerRole ? ` and received the **${winnerRole.name}** role` : ''}!`;
    } else {
      tournament.winnerTeam = null;
      saveGuildStore(interaction.guildId, store);
    }
  }

  const lines = [`✅ ${label} qualifiers updated: ${selectedNames.length ? selectedNames.map(t => `**${t}**`).join(', ') : '_none selected_'}`];
  if (promoted.length) lines.push(`🏆 ${promoted.join('\n🏆 ')}`);
  if (failed.length) lines.push(`⚠️ Couldn't find/create a Round ${nextRound} slot for: ${failed.map(t => `**${t}**`).join(', ')} — check my Manage Roles/Manage Channels permissions.`);
  if (winnerLine) lines.push(winnerLine);

  await interaction.editReply({ content: lines.join('\n'), embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Per-group admin panel — Publish Slot List / Punish Team (posted
// automatically in each group's own channel, see
// buildTournamentGroupAdminPanelPayload)
// ---------------------------------------------------------------------------

// "Publish Slot List" — publishes the group's current slot list into its
// own channel (where the button lives), and mirrors it to the
// Slot-Manager channel if one's configured. Re-clicking edits the same
// message in place (new teams show up in it) instead of spamming a fresh
// copy every time — a message only gets (re-)sent if there's no previous
// one to edit, or that one was deleted.
async function handleTourneyGroupPublish(interaction, store, tournament, roundNum, letter) {
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];
  if (!tournament || !group) {
    return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const embed = buildTournamentSlotListEmbed(tournament, letter, group, roundNum);

  const publishOnce = async (channel, messageIdKey) => {
    const existingId = group[messageIdKey];
    if (existingId) {
      const existing = await channel.messages.fetch(existingId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] }).catch(() => {});
        return;
      }
    }
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) group[messageIdKey] = sent.id;
  };

  await publishOnce(interaction.channel, 'slotListMessageId');

  if (tournament.slotManagerChannelId && tournament.slotManagerChannelId !== interaction.channelId) {
    const publishChannel = interaction.guild.channels.cache.get(tournament.slotManagerChannelId);
    if (publishChannel) await publishOnce(publishChannel, 'slotListManagerMessageId');
  }

  saveGuildStore(interaction.guildId, store);

  return interaction.reply({
    content: `✅ Slot list published for ${roundNum > 1 ? `Round ${roundNum} ` : ''}Group **${letter}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

// Team picker shown by "Punish Team" — same shape as the Qualify picker,
// just for banning instead.
function buildTournamentPunishSelectPayload(tournament, tid, roundNum, letter) {
  const group = getRoundGroups(tournament, roundNum)[letter];
  const label = roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
  if (!group) {
    return { error: `❌ ${label} doesn't exist.` };
  }
  if (!group.teams.length) {
    return { error: `❌ ${label} has no registered teams yet.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ ${label} has ${group.teams.length} teams — Discord select menus cap at 25 options.` };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tourney_punish_select_teams:${tid}:${roundNum}:${letter}`)
    .setPlaceholder(`Select team(s) to punish from ${label}`)
    .setMinValues(1)
    .setMaxValues(group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({ label: t.team.slice(0, 100), value: String(idx) })));

  const embed = new EmbedBuilder()
    .setTitle(`🔨 Punish Teams — ${label}`)
    .setColor(0xED4245)
    .setDescription('Select every team to punish — each is banned from re-registering, removed from this group, and loses this group\'s role (and any later round they\'d already reached).');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// On submit: bans the picked team name(s), evicts them from the group
// where "Punish Team" was clicked, and strips this group's role — plus
// cascades forward through any later round they'd already been promoted
// into (their standing in earlier rounds is left alone, since punishing
// from a Round 3 channel shouldn't quietly erase a team's Round 1 slot).
// Never lets one player's role removal fail block the rest.
async function handleTournamentPunishSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];

  if (!tournament || !group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const indices = new Set(interaction.values.map(v => parseInt(v, 10)));
  const punishedTeams = group.teams.filter((t, idx) => indices.has(idx));

  if (!punishedTeams.length) {
    return interaction.update({ content: '❌ Nothing selected.', embeds: [], components: [] });
  }

  await interaction.deferUpdate();

  if (!tournament.bannedTeams) tournament.bannedTeams = [];
  const groupRoleId = group.roleId;
  const label = roundNum > 1 ? `Round ${roundNum} Group ${letter}` : `Group ${letter}`;
  const lines = [];

  for (const team of punishedTeams) {
    if (!tournament.bannedTeams.includes(team.team.toLowerCase())) {
      tournament.bannedTeams.push(team.team.toLowerCase());
    }
    await removeTeamFromRoundOnward(interaction, store, tournament, team, roundNum + 1);
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (groupRoleId) await member.roles.remove(groupRoleId).catch(() => {});
    }
    lines.push(`🔨 **${team.team}** banned and removed from ${label}.`);
  }

  group.teams = group.teams.filter(t => !punishedTeams.includes(t));
  tournament.qualified = tournament.qualified.filter(name => !punishedTeams.some(t => t.team === name));
  saveGuildStore(interaction.guildId, store);

  await interaction.editReply({ content: lines.join('\n'), embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Slot list flow
// ---------------------------------------------------------------------------
// Picker shown after clicking "Slot List" — pick which group to view.
// Returns { error } when there's nothing to pick from yet.
function buildSlotListGroupSelectPayload(tournament) {
  const letters = Object.keys(tournament.groups);
  if (!letters.length) {
    return { error: '❌ No groups exist yet — add one first.' };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_slotlist_select')
    .setPlaceholder('Select a group to view its slot list')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(letters.map(letter => ({
      label: `Group ${letter}`,
      description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
      value: letter,
    })));

  const embed = new EmbedBuilder()
    .setTitle('🔢 Tournament Slot List')
    .setColor(0x5865F2)
    .setDescription('Pick a group — its slot list is generated automatically from current registrations.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleSlotListSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [letter] = interaction.values;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const embed = buildTournamentSlotListEmbed(tournament, letter, tournament.groups[letter], 1);
  await interaction.update({ content: '', embeds: [embed], components: [] });

  // Also publish to the configured Slot-Manager channel, if set — this is
  // what that channel is for (a running, publicly-visible copy of slot
  // lists) separate from this ephemeral admin view.
  if (tournament.slotManagerChannelId) {
    const publishChannel = interaction.guild.channels.cache.get(tournament.slotManagerChannelId);
    if (publishChannel) {
      await publishChannel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Cancel Slots flow
// ---------------------------------------------------------------------------
function buildCancelGroupSelectPayload(tournament) {
  const letters = Object.keys(tournament.groups).filter(l => tournament.groups[l].teams.length > 0);
  if (!letters.length) {
    return { error: '❌ No registered teams in any group yet.' };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_cancel_group_select')
    .setPlaceholder('Select a group to cancel slots from')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(letters.map(letter => ({
      label: `Group ${letter}`,
      description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
      value: letter,
    })));

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Cancel Slots')
    .setColor(0xED4245)
    .setDescription('Pick a group, then choose which team(s) to remove.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function buildCancelTeamsSelectPayload(tournament, letter) {
  const group = tournament.groups[letter];
  if (!group) {
    return { error: `❌ Group **${letter}** doesn't exist.` };
  }
  if (!group.teams.length) {
    return { error: `❌ Group **${letter}** has no registered teams.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ Group **${letter}** has ${group.teams.length} teams — over Discord's 25-option select limit.` };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`cancel_select_teams:${letter}`)
    .setPlaceholder(`Select team(s) to remove from Group ${letter}`)
    .setMinValues(1)
    .setMaxValues(group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({ label: t.team.slice(0, 100), value: String(idx) })));

  const embed = new EmbedBuilder()
    .setTitle(`🗑️ Cancel Slots — Group ${letter}`)
    .setColor(0xED4245)
    .setDescription('Select every team to remove, then confirm.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleCancelGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [letter] = interaction.values;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const payload = buildCancelTeamsSelectPayload(tournament, letter);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleCancelTeamsSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, letter] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const group = tournament.groups[letter];
  const removeIndices = new Set(interaction.values.map(v => parseInt(v, 10)));
  const removedTeams = group.teams.filter((t, idx) => removeIndices.has(idx));
  const removedNames = removedTeams.map(t => t.team);
  group.teams = group.teams.filter((t, idx) => !removeIndices.has(idx));

  await interaction.deferUpdate();
  for (const team of removedTeams) {
    await removeTeamFromRoundOnward(interaction, store, tournament, team, 2);
  }

  const removedSet = new Set(removedNames);
  tournament.qualified = tournament.qualified.filter(name => !removedSet.has(name));
  saveGuildStore(interaction.guildId, store);

  await interaction.editReply({
    content: `🗑️ Removed from Group ${letter}: ${removedNames.map(n => `**${n}**`).join(', ')}`,
    embeds: [],
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Slot-Manager channel select (ChannelSelectMenu)
// ---------------------------------------------------------------------------
async function handleSlotManagerChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }

  const channel = interaction.channels.first();
  store.tournament.slotManagerChannelId = channel.id;
  const tid = store.tournament.id;
  saveGuildStore(interaction.guildId, store);

  await channel.send(buildSlotSelfServicePanelPayload(tid)).catch(() => {});

  await interaction.update({ content: `✅ Slot-Manager channel set to ${channel} — the self-service panel has been posted there.`, components: [] });
}

// Finds the team (if any) a given user belongs to — as the owner or as a
// listed player — across every group in the tournament. A player can only
// ever be on one team at a time (enforced at registration), so the first
// match is the only match.
function findUserTournamentEntry(tournament, userId) {
  for (const letter of Object.keys(tournament.groups)) {
    const group = tournament.groups[letter];
    const idx = group.teams.findIndex(t => t.ownerId === userId || (t.playerIds || []).includes(userId));
    if (idx !== -1) return { letter, group, idx, team: group.teams[idx] };
  }
  return null;
}

// Public self-service panel — posted automatically in the configured
// Slot-Manager channel. Lets a registered player cancel their own slot,
// check which group they're in, or rename their own team, without needing
// an admin.
function buildSlotSelfServicePanelPayload(tid) {
  const embed = new EmbedBuilder()
    .setTitle('🎯 Tourney Slot Manager')
    .setColor(0x5865F2)
    .setDescription(
      '• Click **Cancel My Slot** below to cancel your slot.\n' +
      '• Click **My Groups** to see which group your team is in.\n' +
      '• Click **Change Team Name** if you want to update your team\'s name.\n\n' +
      '*Note that slot cancel is irreversible.*'
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_cancel:${tid}`).setLabel('Cancel My Slot').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_my_groups:${tid}`).setLabel('My Groups').setEmoji('🗂️').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_change_name:${tid}`).setLabel('Change Team Name').setEmoji('✏️').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// Submit handler for the "Change Team Name" modal above — renames the
// player's own team in place (same duplicate-name check registration
// uses) and keeps the qualified list in sync if that team already
// qualified under its old name.
async function handleSelfServiceChangeNameModalSubmit(interaction) {
  const tid = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const entry = findUserTournamentEntry(tournament, interaction.user.id);
  if (!entry) {
    return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
  }

  const newName = interaction.fields.getTextInputValue('team').trim();
  if (!newName) {
    return interaction.reply({ content: '❌ Team name cannot be empty.', flags: MessageFlags.Ephemeral });
  }

  const oldName = entry.team.team;
  if (newName.toLowerCase() !== oldName.toLowerCase()) {
    const taken = Object.values(tournament.groups).some(g => g.teams.some(t => t.team.toLowerCase() === newName.toLowerCase()));
    if (taken) {
      return interaction.reply({ content: `❌ A team named **${newName}** is already registered.`, flags: MessageFlags.Ephemeral });
    }
  }

  entry.team.team = newName;
  const qIdx = tournament.qualified.indexOf(oldName);
  if (qIdx !== -1) tournament.qualified[qIdx] = newName;
  saveGuildStore(interaction.guildId, store);

  return interaction.reply({ content: `✅ Team name updated to **${newName}**.`, flags: MessageFlags.Ephemeral });
}

async function handleRegisterPanelChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }

  const channel = interaction.channels.first();
  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return interaction.update({
      content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages**, and **Embed Links** there.`,
      components: [],
    });
  }

  const message = await channel.send(buildTournamentRegisterPanelPayload(store.tournament));
  store.tournament.registerPanelChannelId = channel.id;
  store.tournament.registerPanelMessageId = message.id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: `✅ Registration panel posted in ${channel}.`, components: [] });
}

// Keeps the standalone public registration panel (posted via "Post
// Register Panel") in sync the moment open/closed status changes —
// without this, players would keep seeing a stale "Open"/"Closed" status
// until someone manually re-posted the panel. Best-effort: if the message
// or channel was deleted, this just quietly gives up rather than erroring
// out whatever triggered the refresh. Takes the tournament object
// directly (rather than pulling it off an admin-bound store) since this
// also gets called from the public registration-confirm flow, which has
// no admin session to bind `store.tournament` to.
async function refreshRegisterPanel(guild, tournament) {
  if (!tournament.registerPanelChannelId || !tournament.registerPanelMessageId) return;
  try {
    const channel = await guild.channels.fetch(tournament.registerPanelChannelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(tournament.registerPanelMessageId).catch(() => null);
    if (!message) return;
    await message.edit(buildTournamentRegisterPanelPayload(tournament));
  } catch (err) {
    console.error(`[tournament-register-panel] Failed to refresh register panel in guild ${guild.id}: ${err.message}`);
  }
}

module.exports = {
  buildTournamentListPayload,
  handleTournamentListSelect,
  buildTournamentWizardPayload,
  buildTournamentRegisterPanelPayload,
  handleTournamentWizardButton,
  handleTournamentCreateModalSubmit,
  handleAddGroupModalSubmit,
  handleAutoGroupsModalSubmit,
  handleRegisterTeamModalSubmit,
  handleTourneyRegSelectPlayers,
  handleEditSettingsModalSubmit,
  handleBanUnbanModalSubmit,
  handleManualAddSlotModalSubmit,
  handleManualAddUserSelect,
  handleManualAddGroupSelect,
  handleSwapTeamASelect,
  handleSwapTeamBSelect,
  handleSwapDecision,
  buildQualifySelectPayload,
  handleQualifySelect,
  buildQualifyGroupSelectPayload,
  handleQualifyGroupSelect,
  buildSlotListGroupSelectPayload,
  handleSlotListSelect,
  handleCancelGroupSelect,
  handleCancelTeamsSelect,
  handleSlotManagerChannelSelect,
  handleRegisterPanelChannelSelect,
  handleRequiredMentionsModalSubmit,
  handleTeamsPerGroupModalSubmit,
  handleTotalSlotsModalSubmit,
  handleCreateConfirmChannelSelect,
  handleTournamentPunishSelect,
  handleManualChannelsFormatModalSubmit,
  handleManualChannelsCategoryNameModalSubmit,
  handleManualChannelsRoleNameModalSubmit,
  handleSelfServiceChangeNameModalSubmit,
  handleRoundConfigSelect,
  handleRoundConfigButton,
  handleRoundSizeModalSubmit,
  handleRoundNamingModalSubmit,
  handleMaxRoundsModalSubmit,
};

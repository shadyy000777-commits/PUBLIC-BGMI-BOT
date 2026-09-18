require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Collection, MessageFlags,
  PermissionFlagsBits, REST, Routes, ActivityType,
} = require('discord.js');

// ---------------------------------------------------------------------
// Both bots' handler modules, imported as whole namespaces (not
// destructured) and prefixed t3*/rb*. Several functions share the exact
// same name between the two bots (e.g. handleRegisterButton), so
// destructuring both into one scope would silently clobber one of them.
// Keeping each behind its own namespace object avoids that entirely.
// ---------------------------------------------------------------------
const t3Registration = require('./t3-registration-handlers');
const t3LivePanel = require('./t3-live-panel-handlers');
const t3GroupSchedule = require('./t3-group-schedule-handlers');
const t3AdminPanel = require('./t3-admin-panel-handlers');
const t3RoundPromotion = require('./round-promotion-handlers');
const t3Slotlist = require('./slotlist-handlers');
const t3Punish = require('./t3-punish-handlers');
const t3ManageSlot = require('./manage-slot-handlers');
const t3ChannelCleanup = require('./channel-cleanup-handlers');

const rbRegistration = require('./registration-handlers');
const rbVerification = require('./verification-handlers');
const rbEmbedBuilder = require('./embed-builder-handlers');
const rbRegister = require('./register-handlers');
const rbScrimWizard = require('./scrim-wizard-handlers');
const rbLivePanel = require('./live-panel-handlers');
const rbPunish = require('./punish-handlers');
const rbTournamentWizard = require('./tournament-wizard-handlers');
const rbIdPanel = require('./id-panel-handlers');
const rbTeamPanel = require('./team-panel-handlers');
const rbGroupSchedule = require('./group-schedule-handlers');
const rbGroupAdmin = require('./group-admin-handlers');
const rbAdminPanel = require('./admin-panel-handlers');
const rbDmRelay = require('./dm-relay');
const rbAiChat = require('./ai-chat');
const rbPremium = require('./premium');
const rbSsVerification = require('./ss-verification');
const rbStorage = require('./storage');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
client.commands = new Collection();
client.prefixCommands = new Collection();

// ---------------------------------------------------------------------
// Load every slash + prefix command file (all bots' files sit flat in
// this same folder) into one shared set of collections. A few names and
// filenames collided between the two original bots (admin-panel,
// remove-registration, open, team/viewteam, storage.js, etc.) — the T3
// copies were the ones renamed (t3-admin-panel, t3-storage.js, ...) to
// make room, since Rebound is the larger/more actively developed bot.
// ---------------------------------------------------------------------
function loadCommands(dir) {
  const commandFiles = fs.readdirSync(dir).filter(f => f.startsWith('cmd-') && f.endsWith('.js'));
  for (const file of commandFiles) {
    const command = require(path.join(dir, file));
    if (client.commands.has(command.data.name)) {
      throw new Error(`Duplicate slash command name "${command.data.name}" from ${dir}/${file}`);
    }
    client.commands.set(command.data.name, command);
  }

  const prefixCommandFiles = fs.readdirSync(dir).filter(f => f.startsWith('pcmd-') && f.endsWith('.js'));
  for (const file of prefixCommandFiles) {
    const command = require(path.join(dir, file));
    if (client.prefixCommands.has(command.name)) {
      throw new Error(`Duplicate prefix command name "${command.name}" from ${dir}/${file}`);
    }
    client.prefixCommands.set(command.name, command);
    for (const alias of command.aliases || []) {
      if (client.prefixCommands.has(alias)) {
        throw new Error(`Duplicate prefix command alias "${alias}" from ${dir}/${file}`);
      }
      client.prefixCommands.set(alias, command);
    }
  }
}

loadCommands(__dirname);

async function registerCommandsForGuild(guild, commandData, rest) {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
    { body: commandData }
  );
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Loaded ${client.commands.size} slash commands, ${client.prefixCommands.size} prefix command entries.`);
  console.log(`Currently in ${client.guilds.cache.size} server(s).`);

  client.user.setPresence({
    activities: [{
      name: 'Custom Status',
      state: process.env.BOT_STATUS_TEXT || '🔥 T3 + BGMI Scrims',
      type: ActivityType.Custom,
    }],
    status: 'online',
  });

  // Background jobs from both bots. Each only touches its own bot's data
  // store (t3/storage.js vs rebound/storage.js each keep their own
  // data.json), so running both side by side is safe.
  t3LivePanel.startLivePanelDayRollover(client);
  rbLivePanel.startLivePanelDayRollover(client);
  t3Punish.startScrimsBanExpiry(client);
  rbPunish.startScrimsBanExpiry(client);
  rbPunish.startScrimsBanRoleWatcher(client);

  if (process.env.CLIENT_ID) {
    const commandData = client.commands.map(c => c.data.toJSON());
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);

    try {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
      console.log('Cleared any leftover global commands.');
    } catch (err) {
      console.error('Failed to clear global commands:', err);
    }

    let successCount = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        await registerCommandsForGuild(guild, commandData, rest);
        successCount++;
      } catch (err) {
        console.error(`Failed to register commands in guild ${guild.id} (${guild.name}):`, err);
      }
    }
    console.log(`Registered ${commandData.length} commands in ${successCount}/${client.guilds.cache.size} server(s).`);
  } else {
    console.warn('CLIENT_ID not set — skipping automatic slash command registration.');
  }
});

client.on('guildCreate', async (guild) => {
  if (!process.env.CLIENT_ID) return;
  try {
    const commandData = client.commands.map(c => c.data.toJSON());
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await registerCommandsForGuild(guild, commandData, rest);
    console.log(`Joined new server "${guild.name}" — registered ${commandData.length} commands there.`);
  } catch (err) {
    console.error(`Failed to register commands in new guild ${guild.id} (${guild.name}):`, err);
  }
});

client.on('channelDelete', (channel) => {
  handleChannelDeletedSafe(channel);
});
function handleChannelDeletedSafe(channel) {
  t3ChannelCleanup.handleChannelDeleted(channel).catch(err =>
    console.error('Failed to clean up after channel deletion:', err)
  );
}

// ---------------------------------------------------------------------
// messageCreate — based on the Rebound bot's fuller version (DM relay,
// screenshot verification, AI mention-chat, role-list lookups), since it
// is a strict superset of what the T3 bot's messageCreate did. Prefix
// commands route through the single merged client.prefixCommands
// collection, so T3's !t3open / !t3team keep working the same way.
// ---------------------------------------------------------------------
const PING_OWNER_REGEX = /^\s*ping[.!?]?\s*$|\bping\s+(shady|owner|dev|developer|creator|him|her|them)\b/i;

async function tryHandlePingOwner(message, cleanContent) {
  if (!PING_OWNER_REGEX.test(cleanContent)) return false;
  const ownerId = process.env.OWNER_ID;
  if (!ownerId) {
    console.warn('[ping-owner] OWNER_ID not set in .env — skipping.');
    return false;
  }
  await message.reply({ content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } });
  return true;
}

const GENDER_WORD_GROUPS = [
  { trigger: /\b(girl|girls|female|females|lady|ladies|woman|women)\b/i, roleMatch: ['girl', 'female', 'lady', 'ladies', 'woman', 'women'] },
  { trigger: /\b(boy|boys|male|males|man|men|guy|guys)\b/i, roleMatch: ['boy', 'male', 'man', 'men', 'guy'] },
];

function findMatchingRoles(guild, cleanContent, mentionedRoles) {
  const found = new Map();
  for (const r of mentionedRoles) found.set(r.id, r);
  const allRoles = [...guild.roles.cache.values()].filter(r => r.name !== '@everyone');
  const lower = cleanContent.toLowerCase();

  for (const group of GENDER_WORD_GROUPS) {
    if (!group.trigger.test(cleanContent)) continue;
    for (const r of allRoles) {
      const roleName = r.name.toLowerCase();
      if (group.roleMatch.some(m => roleName.includes(m))) found.set(r.id, r);
    }
  }

  if (found.size === 0) {
    const sorted = [...allRoles].sort((a, b) => b.name.length - a.name.length);
    const match = sorted.find(r => lower.includes(r.name.toLowerCase()));
    if (match) found.set(match.id, match);
  }
  return [...found.values()];
}

async function tryHandleRoleListRequest(message, cleanContent) {
  const listIntentRegex = /\b(list|show|who\s*has|who\s*have|give me|members?\s+with)\b/i;
  if (!listIntentRegex.test(cleanContent)) return false;

  const roles = findMatchingRoles(message.guild, cleanContent, [...message.mentions.roles.values()]);
  if (roles.length === 0) return false;

  try {
    await message.guild.members.fetch();
  } catch (err) {
    console.error('[role-list] Failed to fetch guild members:', err);
  }

  const sections = roles.map(role => {
    const all = [...role.members.values()];
    if (all.length === 0) return `**${role.name}** — no one currently has this role.`;
    const picked = all.length <= 10 ? all : all.sort(() => Math.random() - 0.5).slice(0, 10);
    const lines = picked.map(m => `• ${m}`).join('\n');
    return `**${role.name}** — showing ${picked.length} of ${all.length}:\n${lines}`;
  });

  await message.reply(sections.join('\n\n'));
  return true;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (!message.guild) {
    await rbDmRelay.relayDmReply(message, client);
    return;
  }

  const ssStore = rbStorage.getGuildStore(message.guild.id);
  if (ssStore.settings && ssStore.settings.ssVerifyChannelId === message.channelId) {
    try {
      await rbSsVerification.handleSsVerifyMessage(message);
    } catch (err) {
      console.error('Error handling SS-verify screenshot:', err);
      await message.reply('❌ Something went wrong verifying that screenshot. Please try again.').catch(() => {});
    }
    return;
  }

  const prefix = process.env.PREFIX || '!';
  const looksLikePrefixCommand = message.content.startsWith(prefix);

  const mentionsBot = message.mentions.has(client.user);
  const isReplyToBot = message.reference?.messageId
    ? await message.channel.messages.fetch(message.reference.messageId)
        .then(referenced => referenced.author.id === client.user.id)
        .catch(() => false)
    : false;

  if (!looksLikePrefixCommand && (mentionsBot || isReplyToBot)) {
    const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();
    if (cleanContent) {
      try {
        const handledAsPingOwner = await tryHandlePingOwner(message, cleanContent);
        if (handledAsPingOwner) return;

        const handledAsRoleList = await tryHandleRoleListRequest(message, cleanContent);
        if (handledAsRoleList) return;

        if (!rbPremium.isPremiumGuild(message.guild.id)) {
          await message.reply('⭐ AI chat is a premium feature. Contact the bot owner to upgrade this server.').catch(() => {});
          return;
        }

        await message.channel.sendTyping();
        const reply = await rbAiChat.getAIReply({
          guildId: message.guild.id,
          guildName: message.guild.name,
          channelId: message.channelId,
          userDisplayName: message.member?.displayName || message.author.username,
          userMessage: cleanContent,
        });
        if (reply) {
          const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
        }
      } catch (err) {
        console.error('Error generating AI reply:', err);
      }
    }
    return;
  }

  if (!looksLikePrefixCommand) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();
  if (!commandName) return;

  const command = client.prefixCommands.get(commandName);
  if (!command) return;

  if (command.adminOnly && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply('❌ You need the **Manage Server** permission to use this command.').catch(() => {});
  }

  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error running prefix command "${commandName}":`, err);
    message.reply('❌ Something went wrong running that command.').catch(() => {});
  }
});

// ---------------------------------------------------------------------
// interactionCreate — merged dispatch. Slash commands route generically
// through the shared client.commands collection. Buttons/selects/modals
// are matched by customId; the two bots' customId spaces were confirmed
// non-overlapping except group_schedule_select / group_schedule_modal:,
// which is why the T3 copies were renamed to t3_group_schedule_select /
// t3_group_schedule_modal: above.
// ---------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) {
    if (interaction.isRepliable()) {
      return interaction.reply({ content: 'This bot only works inside a server.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
    } else if (interaction.isButton()) {
      const id = interaction.customId;
      // --- T3 ---
      if (id === 't3reg_start') await t3Registration.handleRegisterButton(interaction);
      else if (id === 't3reg_edit_start') await t3Registration.handleEditButton(interaction);
      else if (id === 't3reg_continue_2') await t3Registration.handleStep2Button(interaction);
      else if (id === 't3reg_continue_3') await t3Registration.handleStep3Button(interaction);
      else if (id === 't3reg_retry_step1') await t3Registration.handleRetryStep1(interaction);
      else if (id === 't3reg_retry_step2') await t3Registration.handleRetryStep2(interaction);
      else if (id === 't3reg_retry_step3') await t3Registration.handleRetryStep3(interaction);
      else if (id === 'admin_post_reg_panel') await t3AdminPanel.handlePostRegPanel(interaction);
      else if (id === 'admin_post_live_panel') await t3AdminPanel.handlePostLivePanel(interaction);
      else if (id === 'admin_clear_role') await t3AdminPanel.handleClearRole(interaction);
      else if (id === 'admin_set_groups_per_day') await t3AdminPanel.handleSetGroupsPerDayButton(interaction);
      else if (id === 'admin_edit_daily_schedule') await t3AdminPanel.handleEditDailyScheduleButton(interaction);
      else if (id === 'admin_group_schedule') await t3AdminPanel.handleGroupScheduleButton(interaction);
      else if (id.startsWith('t3_result:')) await t3RoundPromotion.handleResultButton(interaction);
      else if (id.startsWith('t3_reminder:')) await t3RoundPromotion.handleReminderButton(interaction);
      else if (id.startsWith('t3_publish:')) await t3Slotlist.handlePublishButton(interaction);
      else if (id.startsWith('t3_manage:')) await t3ManageSlot.handleManageSlotButton(interaction);
      else if (id.startsWith('t3_punish:')) await t3Punish.handlePunishButton(interaction);
      else if (id.startsWith('t3_delete_confirm:')) await t3RoundPromotion.handleDeleteConfirmButton(interaction);
      else if (id.startsWith('t3_delete_cancel:')) await t3RoundPromotion.handleDeleteCancelButton(interaction);
      else if (id.startsWith('t3_delete:')) await t3RoundPromotion.handleDeleteButton(interaction);
      // --- Rebound ---
      else if (id === 'scrim_register_start') await rbRegistration.handleRegisterButton(interaction);
      else if (id === 'scrim_register_continue_2') await rbRegistration.handleStep2Button(interaction);
      else if (id === 'scrim_register_continue_3') await rbRegistration.handleStep3Button(interaction);
      else if (id === 'verify_start') await rbVerification.handleVerifyButton(interaction);
      else if (id === 'verify_edit_start') await rbVerification.handleVerifyEditButton(interaction);
      else if (id === 'verify_continue_2') await rbVerification.handleVerifyStep2Button(interaction);
      else if (id === 'verify_continue_3') await rbVerification.handleVerifyStep3Button(interaction);
      else if (id === 'verify_retry_step1') await rbVerification.handleVerifyRetryStep1(interaction);
      else if (id === 'verify_retry_step2') await rbVerification.handleVerifyRetryStep2(interaction);
      else if (id === 'verify_retry_step3') await rbVerification.handleVerifyRetryStep3(interaction);
      else if (id.startsWith('embed_')) await rbEmbedBuilder.handleEmbedButton(interaction);
      else if (id === 'register_team_start') await rbRegister.handleRegisterTeamButton(interaction);
      else if (id === 'register_change_slot') await rbRegister.handleChangeSlotButton(interaction);
      else if (id.startsWith('group_change_slot:')) await rbRegister.handleManageMatchesButton(interaction);
      else if (id === 'register_manage_matches') await rbRegister.handleManageMatchesButton(interaction);
      else if (id === 'register_cancel_slot_confirm') await rbRegister.handleCancelSlotConfirmButton(interaction);
      else if (id === 'register_cancel_slot_abort') await rbRegister.handleCancelSlotAbortButton(interaction);
      else if (id === 'register_cancel_slot_execute') await rbRegister.handleCancelSlotExecuteButton(interaction);
      else if (id === 'register_use_old') await rbRegister.handleUseOldTeam(interaction);
      else if (id === 'reg_use_old_continue') await rbRegister.handleUseOldTeamContinue(interaction);
      else if (id === 'register_edit_team') await rbRegister.handleEditTeam(interaction);
      else if (id === 'register_new_team') await rbRegister.handleNewTeam(interaction);
      else if (id === 'reg_continue_2') await rbRegister.handleRegStep2Button(interaction);
      else if (id === 'reg_continue_3') await rbRegister.handleRegStep3Button(interaction);
      else if (id === 'reg_retry_step1') await rbRegister.handleRegRetryStep1(interaction);
      else if (id === 'reg_retry_step2') await rbRegister.handleRegRetryStep2(interaction);
      else if (id === 'reg_retry_step3') await rbRegister.handleRegRetryStep3(interaction);
      else if (id === 'reg_confirm_register') await rbRegister.handleRegConfirmRegister(interaction);
      else if (id === 'reg_cancel_register') await rbRegister.handleRegCancelRegister(interaction);
      else if (id.startsWith('scrim_wizard_')) await rbScrimWizard.handleScrimWizardButton(interaction);
      else if (id.startsWith('tourney_wizard_') || id.startsWith('tourney_create_settings_')) await rbTournamentWizard.handleTournamentWizardButton(interaction);
      else if (id === 'idpanel_send') await rbIdPanel.handleIdPanelButton(interaction);
      else if (id.startsWith('team_panel_')) await rbTeamPanel.handleTeamPanelButton(interaction);
      else if (id.startsWith('group_admin_')) await rbGroupAdmin.handleGroupAdminButton(interaction);
      else if (id.startsWith('tourney_round_config_')) await rbTournamentWizard.handleRoundConfigButton(interaction);
      else if (id.startsWith('admin_panel:')) await rbAdminPanel.handleAdminPanelButton(interaction);
    } else if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id === 't3reg_select_players') await t3Registration.handleSelectPlayers(interaction);
      else if (id === 'verify_select_players') await rbVerification.handleVerifyPlayerSelect(interaction);
      else if (id === 'reg_select_players') await rbRegister.handleRegSelectPlayers(interaction);
      else if (id === 'tourney_reg_select_players') await rbTournamentWizard.handleTourneyRegSelectPlayers(interaction);
    } else if (interaction.isChannelSelectMenu()) {
      const id = interaction.customId;
      if (id === 'admin_log_channel_select') await t3AdminPanel.handleLogChannelSelect(interaction);
      else if (id === 'admin_post_reg_panel_channel_select') await t3AdminPanel.handlePostRegPanelChannelSelect(interaction);
      else if (id === 'admin_post_live_panel_channel_select') await t3AdminPanel.handlePostLivePanelChannelSelect(interaction);
      else if (id === 'idpanel_channel_select') await rbIdPanel.handleIdPanelChannelSelect(interaction);
      else if (id === 'tourney_slotmanager_channel_select') await rbTournamentWizard.handleSlotManagerChannelSelect(interaction);
      else if (id === 'tourney_register_panel_channel_select') await rbTournamentWizard.handleRegisterPanelChannelSelect(interaction);
      else if (id === 'tourney_create_confirmchannel_select') await rbTournamentWizard.handleCreateConfirmChannelSelect(interaction);
      else if (id.startsWith('admin_panel_channel_select:')) await rbAdminPanel.handleAdminPanelChannelSelect(interaction);
    } else if (interaction.isRoleSelectMenu()) {
      const id = interaction.customId;
      if (id === 'admin_role_select') await t3AdminPanel.handleRoleSelect(interaction);
      else if (id.startsWith('admin_panel_role_select:')) await rbAdminPanel.handleAdminPanelRoleSelect(interaction);
    } else if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      // --- T3 ---
      if (id === 't3_group_schedule_select') await t3GroupSchedule.handleGroupScheduleSelect(interaction);
      else if (id.startsWith('t3_qualify:')) await t3RoundPromotion.handleQualifySelectSubmit(interaction);
      else if (id.startsWith('t3_punish_select:')) await t3Punish.handlePunishSelect(interaction);
      else if (id === 't3_manage_group_select') await t3ManageSlot.handleManageSlotGroupSelect(interaction);
      // --- Rebound ---
      else if (id === 'change_slot_group_select') await rbRegister.handleChangeSlotGroupSelect(interaction);
      else if (id === 'reg_select_group') await rbRegister.handleRegGroupSelect(interaction);
      else if (id === 'tourney_list_select') await rbTournamentWizard.handleTournamentListSelect(interaction);
      else if (id.startsWith('qualify_select_teams:')) await rbTournamentWizard.handleQualifySelect(interaction);
      else if (id === 'tourney_qualify_group_select') await rbTournamentWizard.handleQualifyGroupSelect(interaction);
      else if (id === 'tourney_cancel_group_select') await rbTournamentWizard.handleCancelGroupSelect(interaction);
      else if (id === 'tourney_round_config_select') await rbTournamentWizard.handleRoundConfigSelect(interaction);
      else if (id.startsWith('cancel_select_teams:')) await rbTournamentWizard.handleCancelTeamsSelect(interaction);
      else if (id === 'tourney_slotlist_select') await rbTournamentWizard.handleSlotListSelect(interaction);
      else if (id === 'group_schedule_select') await rbGroupSchedule.handleGroupScheduleSelect(interaction);
      else if (id.startsWith('punish_select_teams:')) await rbPunish.handlePunishSelect(interaction);
      else if (id.startsWith('tourney_punish_select_teams:')) await rbTournamentWizard.handleTournamentPunishSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      // --- T3 ---
      if (id === 't3reg_step1') await t3Registration.handleStep1Submit(interaction);
      else if (id === 't3reg_step2') await t3Registration.handleStep2Submit(interaction);
      else if (id === 't3reg_step3') await t3Registration.handleStep3Submit(interaction);
      else if (id.startsWith('t3_group_schedule_modal:')) await t3GroupSchedule.handleGroupScheduleModalSubmit(interaction);
      else if (id === 'daily_schedule_modal') await t3AdminPanel.handleDailyScheduleModalSubmit(interaction);
      else if (id === 'admin_groups_per_day_modal') await t3AdminPanel.handleGroupsPerDayModalSubmit(interaction);
      // --- Rebound ---
      else if (id === 'scrim_reg_step1') await rbRegistration.handleStep1Submit(interaction);
      else if (id === 'scrim_reg_step2') await rbRegistration.handleStep2Submit(interaction);
      else if (id === 'scrim_reg_step3') await rbRegistration.handleStep3Submit(interaction);
      else if (id === 'verify_step1') await rbVerification.handleVerifyStep1Submit(interaction);
      else if (id === 'verify_step2') await rbVerification.handleVerifyStep2Submit(interaction);
      else if (id === 'verify_step3') await rbVerification.handleVerifyStep3Submit(interaction);
      else if (id.startsWith('embed_modal_')) await rbEmbedBuilder.handleEmbedModalSubmit(interaction);
      else if (id === 'reg_step1') await rbRegister.handleRegStep1Submit(interaction);
      else if (id === 'reg_step2') await rbRegister.handleRegStep2Submit(interaction);
      else if (id === 'reg_step3') await rbRegister.handleRegStep3Submit(interaction);
      else if (id === 'scrim_wizard_create_modal') await rbScrimWizard.handleScrimCreateModalSubmit(interaction);
      else if (id === 'scrim_wizard_edit_modal') await rbScrimWizard.handleScrimEditModalSubmit(interaction);
      else if (id === 'tourney_wizard_create_modal') await rbTournamentWizard.handleTournamentCreateModalSubmit(interaction);
      else if (id === 'tourney_wizard_group_modal') await rbTournamentWizard.handleAddGroupModalSubmit(interaction);
      else if (id === 'tourney_wizard_auto_groups_modal') await rbTournamentWizard.handleAutoGroupsModalSubmit(interaction);
      else if (id.startsWith('tourney_wizard_register_modal:')) await rbTournamentWizard.handleRegisterTeamModalSubmit(interaction);
      else if (id === 'tourney_wizard_edit_modal') await rbTournamentWizard.handleEditSettingsModalSubmit(interaction);
      else if (id === 'tourney_wizard_ban_modal') await rbTournamentWizard.handleBanUnbanModalSubmit(interaction);
      else if (id === 'tourney_wizard_manual_add_modal') await rbTournamentWizard.handleManualAddSlotModalSubmit(interaction);
      else if (id === 'tourney_create_settings_d_modal') await rbTournamentWizard.handleRequiredMentionsModalSubmit(interaction);
      else if (id === 'tourney_create_settings_e_modal') await rbTournamentWizard.handleTeamsPerGroupModalSubmit(interaction);
      else if (id === 'tourney_create_settings_f_modal') await rbTournamentWizard.handleTotalSlotsModalSubmit(interaction);
      else if (id === 'idpanel_modal') await rbIdPanel.handleIdPanelModalSubmit(interaction);
      else if (id === 'team_panel_modal') await rbTeamPanel.handleTeamPanelModalSubmit(interaction);
      else if (id.startsWith('group_schedule_modal:')) await rbGroupSchedule.handleGroupScheduleModalSubmit(interaction);
      else if (id.startsWith('group_admin_result_modal:')) await rbGroupAdmin.handleGroupAdminResultModalSubmit(interaction);
      else if (id === 'tourney_manual_channels_format_modal') await rbTournamentWizard.handleManualChannelsFormatModalSubmit(interaction);
      else if (id === 'tourney_manual_channels_categoryname_modal') await rbTournamentWizard.handleManualChannelsCategoryNameModalSubmit(interaction);
      else if (id === 'tourney_manual_channels_rolename_modal') await rbTournamentWizard.handleManualChannelsRoleNameModalSubmit(interaction);
      else if (id.startsWith('tourney_selfservice_change_name_modal:')) await rbTournamentWizard.handleSelfServiceChangeNameModalSubmit(interaction);
      else if (id.startsWith('tourney_round_size_modal:')) await rbTournamentWizard.handleRoundSizeModalSubmit(interaction);
      else if (id.startsWith('tourney_round_naming_modal:')) await rbTournamentWizard.handleRoundNamingModalSubmit(interaction);
      else if (id === 'tourney_round_maxrounds_modal') await rbTournamentWizard.handleMaxRoundsModalSubmit(interaction);
      else if (id.startsWith('admin_panel_modal:')) await rbAdminPanel.handleAdminPanelModalSubmit(interaction);
    }
  } catch (err) {
    console.error(`Error handling interaction (${interaction.type}):`, err);
    const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});

client.on('error', (err) => console.error('Discord client error:', err));
client.on('shardError', (err) => console.error('Discord shard error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

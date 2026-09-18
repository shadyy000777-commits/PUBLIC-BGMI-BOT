const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { PLATFORMS, migrateLegacySsSettings, getActiveSsVerifyConfig } = require('./ss-verification');

function settingsOf(interaction) {
  const store = getGuildStore(interaction.guildId);
  migrateLegacySsSettings(store);
  return store;
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ssvp:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );
}

// --- Main panel view ---

function buildSsVerifyPanelPayload(store) {
  migrateLegacySsSettings(store);
  const s = store.settings;
  const { platform, username } = getActiveSsVerifyConfig(store);
  const ch = id => (id ? `<#${id}>` : '*Not set*');
  const role = id => (id ? `<@&${id}>` : '*Not set*');

  const embed = new EmbedBuilder()
    .setTitle('📸 Screenshot Verification Panel')
    .setColor(0x5865F2)
    .setDescription('Configure which platform members have to prove they\'re following/subscribed to, and what role they get once verified.')
    .addFields(
      { name: 'Platform', value: platform ? `${platform.emoji} ${platform.label}` : '*Not set*', inline: true },
      { name: platform ? platform.usernameLabel : 'Username', value: username ? `@${username}` : '*Not set*', inline: true },
      { name: 'Verified Role', value: role(s.ssVerifyRoleId), inline: true },
      { name: 'Submit Channel', value: ch(s.ssVerifyChannelId), inline: true },
      { name: 'Log Channel', value: s.ssVerifyLogChannelId ? ch(s.ssVerifyLogChannelId) : '*Default (auto-created)*', inline: true },
    )
    .setFooter({ text: 'Only you can see this panel.' });

  const missingSetup = [];
  if (!platform) missingSetup.push('Platform');
  if (platform && !username) missingSetup.push(platform.usernameLabel);
  if (!s.ssVerifyRoleId) missingSetup.push('Verified Role');
  if (!s.ssVerifyChannelId) missingSetup.push('Submit Channel');
  if (missingSetup.length) {
    embed.addFields({ name: '⚠️ Still needed', value: missingSetup.join(', ') });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ssvp:set_platform').setLabel('Select Platform').setEmoji('🌐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:set_username').setLabel('Set Username').setEmoji('✏️').setStyle(ButtonStyle.Secondary).setDisabled(!platform),
    new ButtonBuilder().setCustomId('ssvp:set_role').setLabel('Set Verified Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ssvp:set_channel').setLabel('Set Submit Channel').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:set_log_channel').setLabel('Set Log Channel').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// --- Sub-views ---

function buildPlatformSelectView(currentPlatformId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('ssvp_platform_select')
    .setPlaceholder('Choose a platform')
    .addOptions(
      Object.values(PLATFORMS).map(p => ({
        label: p.label,
        value: p.id,
        emoji: p.emoji,
        default: p.id === currentPlatformId,
      })),
    );

  return {
    content: '**Platform** — which service should screenshots be checked against?\n\nPick one below:',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildUsernameModal(platform, currentValue) {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(platform.usernameLabel.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder(platform.usernameHint);

  if (currentValue) input.setValue(currentValue);

  return new ModalBuilder()
    .setCustomId('ssvp_modal_username')
    .setTitle(`Set ${platform.usernameLabel}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildRolePickerView() {
  const select = new RoleSelectMenuBuilder()
    .setCustomId('ssvp_role_select')
    .setPlaceholder('Choose the role to give on verification');

  return {
    content: '**Verified Role** — given automatically once a member\'s screenshots are verified.\n\nPick a role below:',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildChannelPickerView(key, label, hint) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`ssvp_channel_select:${key}`)
    .setPlaceholder(`Choose the ${label}`)
    .addChannelTypes(ChannelType.GuildText);

  return {
    content: `**${label}** — ${hint}\n\nPick a channel below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

// --- Button handler ---

async function handleSsVerifyPanelButton(interaction) {
  const action = interaction.customId.slice('ssvp:'.length);
  const store = settingsOf(interaction);

  if (action === 'refresh' || action === 'back') {
    return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
  }

  if (action === 'set_platform') {
    return interaction.update(buildPlatformSelectView(store.settings.ssVerifyPlatform));
  }

  if (action === 'set_username') {
    const { platform, username } = getActiveSsVerifyConfig(store);
    if (!platform) {
      return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
    }
    return interaction.showModal(buildUsernameModal(platform, username));
  }

  if (action === 'set_role') {
    return interaction.update(buildRolePickerView());
  }

  if (action === 'set_channel') {
    return interaction.update(buildChannelPickerView('channel', 'Submit Channel', 'Where members post their screenshots to get verified'));
  }

  if (action === 'set_log_channel') {
    return interaction.update(buildChannelPickerView('logChannel', 'Log Channel', 'Where completed verifications get logged (optional — falls back to the auto-created log channel)'));
  }
}

// --- Platform string-select handler ---

async function handleSsVerifyPlatformSelect(interaction) {
  const store = settingsOf(interaction);
  const platformId = interaction.values[0];
  const platform = PLATFORMS[platformId];
  if (!platform) return;

  store.settings.ssVerifyPlatform = platformId;
  saveGuildStore(interaction.guildId, store);

  const payload = buildSsVerifyPanelPayload(store);
  const hasUsername = !!(store.settings.ssVerifyUsernames && store.settings.ssVerifyUsernames[platformId]);
  payload.content = hasUsername
    ? `✅ Platform set to **${platform.emoji} ${platform.label}**.`
    : `✅ Platform set to **${platform.emoji} ${platform.label}** — now set the ${platform.usernameLabel.toLowerCase()}.`;
  return interaction.update(payload);
}

// --- Username modal handler ---

async function handleSsVerifyUsernameModalSubmit(interaction) {
  const store = settingsOf(interaction);
  const { platform } = getActiveSsVerifyConfig(store);
  if (!platform) {
    return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
  }

  let raw = interaction.fields.getTextInputValue('value').trim();
  const urlMatch = raw.match(platform.urlRegex);
  if (urlMatch) raw = urlMatch[1];
  const username = raw.replace(/^@/, '');

  if (!platform.usernamePattern.test(username)) {
    return interaction.reply({
      content: `❌ That doesn't look like a valid ${platform.usernameLabel.toLowerCase()}. Use the handle itself or a full profile/channel link.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!store.settings.ssVerifyUsernames) store.settings.ssVerifyUsernames = {};
  store.settings.ssVerifyUsernames[platform.id] = username;
  saveGuildStore(interaction.guildId, store);

  const payload = buildSsVerifyPanelPayload(store);
  payload.content = `✅ **${platform.usernameLabel}** set to **@${username}**.`;
  return interaction.update(payload);
}

// --- Role select handler ---

async function handleSsVerifyRoleSelect(interaction) {
  const store = settingsOf(interaction);
  const role = interaction.roles.first();

  if (role.managed) {
    return interaction.update({
      content: '❌ That role is managed by an integration (e.g. a bot or booster role) and can\'t be assigned manually. Pick a regular role instead.',
      components: [backRow()],
    });
  }

  const botMember = interaction.guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    return interaction.update({
      content: `❌ I can't assign **${role.name}** — it's positioned above my highest role. Move my bot's role above it in Server Settings → Roles.`,
      components: [backRow()],
    });
  }

  store.settings.ssVerifyRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  const payload = buildSsVerifyPanelPayload(store);
  payload.content = `✅ **Verified Role** set to ${role}.`;
  return interaction.update(payload);
}

// --- Channel select handler ---

async function handleSsVerifyChannelSelect(interaction) {
  const key = interaction.customId.slice('ssvp_channel_select:'.length);
  const channel = interaction.channels.first();
  const store = settingsOf(interaction);

  if (key === 'channel') {
    store.settings.ssVerifyChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);
    const payload = buildSsVerifyPanelPayload(store);
    payload.content = `✅ **Submit Channel** set to ${channel}.`;
    return interaction.update(payload);
  }

  if (key === 'logChannel') {
    store.settings.ssVerifyLogChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);
    const payload = buildSsVerifyPanelPayload(store);
    payload.content = `✅ **Log Channel** set to ${channel}.`;
    return interaction.update(payload);
  }
}

module.exports = {
  buildSsVerifyPanelPayload,
  handleSsVerifyPanelButton,
  handleSsVerifyPlatformSelect,
  handleSsVerifyUsernameModalSubmit,
  handleSsVerifyRoleSelect,
  handleSsVerifyChannelSelect,
};

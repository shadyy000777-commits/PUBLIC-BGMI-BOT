const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { buildVerifyPanelPayload } = require('./cmd-verify-panel');
const { buildRegisterPanelPayload } = require('./cmd-register');

// One place that describes every channel/role/message setting the panel
// can edit — the main view, the select-menu prompts, and the save logic
// all read from these instead of repeating the key/label everywhere.
const CHANNEL_SETTINGS = {
  verifyLogChannelId: { label: 'Verify Channel', hint: 'Public verification summary card' },
  privateVerifyLogChannelId: { label: 'Private Verify Channel', hint: 'Full verification card (WhatsApp, email, IGN/UID) — should be staff-only' },
  registrationLogChannelId: { label: 'Register Channel', hint: 'Public registration summary card' },
  privateRegistrationLogChannelId: { label: 'Private Register Channel', hint: 'Full registration card (team #, IGN/UID, substitute) — should be staff-only' },
};

const ROLE_SETTINGS = {
  verifiedRoleId: { label: 'Verify Role', hint: 'Given automatically when a player verifies their team' },
  registeredRoleId: { label: 'Register Role', hint: 'Given automatically when a player registers a team' },
  resultRoleId: { label: 'Result Role', hint: 'Given to teams entered via the group admin panel\'s Result button' },
};

const MESSAGE_SETTINGS = {
  verifyConfirmationMessage: { label: 'Verify Confirmation Message', hint: 'Footer shown on the "Verified" card a player gets after verifying' },
  registerConfirmationMessage: { label: 'Register Confirmation Message', hint: 'Footer shown on the "Registration Complete" card a player gets' },
};

function settingsOf(interaction) {
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  return store;
}

// --- Main panel view ---

function buildAdminPanelPayload(store) {
  const s = store.settings || {};
  const ch = id => (id ? `<#${id}>` : '*Not set*');
  const role = id => (id ? `<@&${id}>` : '*Not set*');
  const msg = text => (text ? `_${text.length > 60 ? `${text.slice(0, 60)}…` : text}_` : '*Default*');

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Admin Panel')
    .setColor(0x5865F2)
    .setDescription('Configure verification, registration, roles and channels — all from here.')
    .addFields(
      { name: '<a:5abed936fdc14d2a8c1a48a1329a4cc0:1549067426912534599> Verify Channel', value: ch(s.verifyLogChannelId), inline: true },
      { name: '<:3409locked:1547663730786177095> Private Verify Channel', value: ch(s.privateVerifyLogChannelId), inline: true },
      { name: '<:431007ticketicon:1549098276702134362> Verify Role', value: role(s.verifiedRoleId), inline: true },
      { name: '<:86258satellite:1549098274114379867> Register Channel', value: ch(s.registrationLogChannelId), inline: true },
      { name: '<:3409locked:1547663730786177095> Private Register Channel', value: ch(s.privateRegistrationLogChannelId), inline: true },
      { name: '<:431007ticketicon:1549098276702134362> Register Role', value: role(s.registeredRoleId), inline: true },
      { name: '<:445259bluestarshiny:1549098279063658647> Result Role', value: role(s.resultRoleId), inline: true },
      { name: '<:dc992fea7ae84f43b24df2e52282cf6f:1549067424685490186> Verify Confirmation Msg', value: msg(s.verifyConfirmationMessage), inline: true },
      { name: '<:dc992fea7ae84f43b24df2e52282cf6f:1549067424685490186> Register Confirmation Msg', value: msg(s.registerConfirmationMessage), inline: true },
    )
    .setFooter({ text: 'Only you can see this panel.' });

  const postRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:post_verify').setLabel('Post Verification Panel').setEmoji('📋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin_panel:post_register').setLabel('Post Registration Panel').setEmoji('📥').setStyle(ButtonStyle.Success),
  );

  const verifyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:set_verifyLogChannelId').setLabel('Verify Channel').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_privateVerifyLogChannelId').setLabel('Private Verify Channel').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_verifiedRoleId').setLabel('Verify Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
  );

  const registerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:set_registrationLogChannelId').setLabel('Register Channel').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_privateRegistrationLogChannelId').setLabel('Private Register Channel').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_registeredRoleId').setLabel('Register Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
  );

  const otherRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:set_resultRoleId').setLabel('Result Role').setEmoji('🌟').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:msg_verifyConfirmationMessage').setLabel('Verify Message').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:msg_registerConfirmationMessage').setLabel('Register Message').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
  );

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  // No `content` key here on purpose — callers that need to clear a
  // leftover banner from a sub-view (channel/role picker) before showing
  // this again do so via `.update()`, which only needs `content: null`
  // when replacing an *existing* message's text. The very first
  // `interaction.reply()` in cmd-admin-panel.js doesn't have that problem.
  return { embeds: [embed], components: [postRow, verifyRow, registerRow, otherRow, refreshRow] };
}

// --- Sub-views: pick a channel / pick a role ---

function buildChannelPickerView(key, label, hint) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`admin_panel_channel_select:${key}`)
    .setPlaceholder(`Choose the ${label}`)
    .addChannelTypes(ChannelType.GuildText);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `**${label}** — ${hint}\n\nPick a channel below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow],
  };
}

function buildRolePickerView(key, label, hint) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`admin_panel_role_select:${key}`)
    .setPlaceholder(`Choose the ${label}`);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `**${label}** — ${hint}\n\nPick a role below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow],
  };
}

function buildMessageModal(key, label, currentValue) {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(label.slice(0, 45))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder('Leave blank to reset to the default message');

  if (currentValue) input.setValue(currentValue);

  return new ModalBuilder()
    .setCustomId(`admin_panel_modal:${key}`)
    .setTitle(label.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// --- Button handler ---

async function handleAdminPanelButton(interaction) {
  const action = interaction.customId.slice('admin_panel:'.length);
  const store = settingsOf(interaction);

  if (action === 'refresh' || action === 'back') {
    // content: null explicitly clears any leftover banner text from a
    // sub-view (channel/role picker) this is returning from — omitting it
    // would leave that old text sitting above the panel embed.
    return interaction.update({ content: null, ...buildAdminPanelPayload(store) });
  }

  if (action === 'post_verify' || action === 'post_register') {
    const label = action === 'post_verify' ? 'Verification Panel' : 'Registration Panel';
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`admin_panel_channel_select:${action}`)
      .setPlaceholder(`Choose a channel to post the ${label} in`)
      .addChannelTypes(ChannelType.GuildText);

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
    );

    return interaction.update({
      content: `Pick a channel to post the **${label}** in:`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), backRow],
    });
  }

  if (action.startsWith('set_')) {
    const key = action.slice('set_'.length);
    if (CHANNEL_SETTINGS[key]) {
      const { label, hint } = CHANNEL_SETTINGS[key];
      return interaction.update(buildChannelPickerView(key, label, hint));
    }
    if (ROLE_SETTINGS[key]) {
      const { label, hint } = ROLE_SETTINGS[key];
      return interaction.update(buildRolePickerView(key, label, hint));
    }
  }

  if (action.startsWith('msg_')) {
    const key = action.slice('msg_'.length);
    if (MESSAGE_SETTINGS[key]) {
      const { label } = MESSAGE_SETTINGS[key];
      return interaction.showModal(buildMessageModal(key, label, store.settings[key]));
    }
  }
}

// --- Channel select handler ---

async function handleAdminPanelChannelSelect(interaction) {
  const key = interaction.customId.slice('admin_panel_channel_select:'.length);
  const channel = interaction.channels.first();
  const store = settingsOf(interaction);

  if (key === 'post_verify' || key === 'post_register') {
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return interaction.update({
        content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages**, and **Embed Links** there.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    try {
      const payload = key === 'post_verify' ? buildVerifyPanelPayload() : buildRegisterPanelPayload();
      await channel.send(payload);
    } catch (err) {
      console.error('Failed to post panel from admin panel:', err);
      return interaction.update({
        content: `❌ Couldn't post to ${channel}. Please check my permissions there.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ ${key === 'post_verify' ? 'Verification' : 'Registration'} panel posted to ${channel}.`;
    return interaction.update(payload);
  }

  if (CHANNEL_SETTINGS[key]) {
    store.settings[key] = channel.id;
    saveGuildStore(interaction.guildId, store);
    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ **${CHANNEL_SETTINGS[key].label}** set to ${channel}.`;
    return interaction.update(payload);
  }
}

// --- Role select handler ---

async function handleAdminPanelRoleSelect(interaction) {
  const key = interaction.customId.slice('admin_panel_role_select:'.length);
  const role = interaction.roles.first();
  const store = settingsOf(interaction);

  if (!ROLE_SETTINGS[key]) return;

  // Same guardrails the standalone /set-*-role commands already use — a
  // managed role can't be assigned by hand, and the bot can't hand out a
  // role positioned above its own highest role.
  if (role.managed) {
    return interaction.update({
      content: '❌ That role is managed by an integration (e.g. a bot or booster role) and can\'t be assigned manually. Pick a regular role instead.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  const botMember = interaction.guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    return interaction.update({
      content: `❌ I can't assign **${role.name}** — it's positioned above my highest role. Move my bot's role above it in Server Settings → Roles.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  store.settings[key] = role.id;
  saveGuildStore(interaction.guildId, store);
  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **${ROLE_SETTINGS[key].label}** set to ${role}.`;
  return interaction.update(payload);
}

// --- Confirmation-message modal handler ---

async function handleAdminPanelModalSubmit(interaction) {
  const key = interaction.customId.slice('admin_panel_modal:'.length);
  if (!MESSAGE_SETTINGS[key]) return;

  const value = interaction.fields.getTextInputValue('value').trim();
  const store = settingsOf(interaction);
  store.settings[key] = value || null;
  saveGuildStore(interaction.guildId, store);

  const payload = buildAdminPanelPayload(store);
  payload.content = value
    ? `✅ **${MESSAGE_SETTINGS[key].label}** updated.`
    : `✅ **${MESSAGE_SETTINGS[key].label}** reset to the default.`;
  return interaction.update(payload);
}

module.exports = {
  buildAdminPanelPayload,
  handleAdminPanelButton,
  handleAdminPanelChannelSelect,
  handleAdminPanelRoleSelect,
  handleAdminPanelModalSubmit,
};

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./storage');
const { buildSsVerifyPanelPayload } = require('./ss-verify-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ss-verify-panel')
    .setDescription('Configure screenshot verification — platform, username, verified role, and channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    await interaction.reply({ ...buildSsVerifyPanelPayload(store), flags: MessageFlags.Ephemeral });
  },
};

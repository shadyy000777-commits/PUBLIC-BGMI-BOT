const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-ss-verify-channel')
    .setDescription('Choose the channel where members post Instagram-follow screenshots to get verified')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The channel members should post their screenshot in')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.ssVerifyChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);

    const missingSetup = [];
    if (!store.settings.instagramUsername) missingSetup.push('`/set-instagram-username`');
    if (!store.settings.ssVerifyRoleId) missingSetup.push('`/set-ss-verify-role`');
    const setupNote = missingSetup.length
      ? `\n⚠️ Still need to run: ${missingSetup.join(', ')}.`
      : '';

    await interaction.reply({
      content: `✅ Members can now post their Instagram-follow screenshot in ${channel} to get verified — it'll be checked automatically.${setupNote}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

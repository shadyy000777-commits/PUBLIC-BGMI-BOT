const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { setPremiumGuild, isBotOwner } = require('./premium');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-premium')
    .setDescription('[Owner only] Grant or revoke premium for this server')
    .addBooleanOption(opt =>
      opt.setName('enabled')
        .setDescription('Turn premium on or off for this server')
        .setRequired(true)),
    // No .setDefaultMemberPermissions() restriction here on purpose — this
    // command is locked to the bot owner's Discord user ID below, not to a
    // server permission. A server's own admins should never be able to
    // grant themselves premium.

  async execute(interaction) {
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: '❌ This command is restricted to the bot owner.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const enabled = interaction.options.getBoolean('enabled');
    setPremiumGuild(interaction.guildId, enabled);

    await interaction.reply({
      content: enabled
        ? `✅ Premium **enabled** for **${interaction.guild.name}**.`
        : `☑️ Premium **disabled** for **${interaction.guild.name}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

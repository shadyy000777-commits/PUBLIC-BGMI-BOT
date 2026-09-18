const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

// Accepts a bare handle or a full profile URL/@-mention and normalizes
// down to just the username, since people will copy-paste either.
function extractUsername(raw) {
  let value = raw.trim();
  const urlMatch = value.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (urlMatch) value = urlMatch[1];
  value = value.replace(/^@/, '');
  return value;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-instagram-username')
    .setDescription('Set the Instagram account everyone must be following for screenshot verification')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('Instagram handle (e.g. reboundesports or @reboundesports)')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const raw = interaction.options.getString('username');
    const username = extractUsername(raw);

    if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
      return interaction.reply({
        content: '❌ That doesn\'t look like a valid Instagram username. Use the handle itself (e.g. `reboundesports`) or a full profile link.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.instagramUsername = username;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: `✅ Screenshot verification will now check for **@${username}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

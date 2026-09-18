const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');

// Shared with the admin panel (see admin-panel-handlers.js) so "post the
// registration panel" only has one place that defines what it looks like —
// the slash command and the panel button both call this.
function buildRegisterPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('<:4321bgmi:1547674231498612837> 𝐓𝐞𝐚𝐦 𝐑𝐞𝐠𝐢𝐬𝐭𝐫𝐚𝐭𝐢𝐨𝐧')
    .setColor(0x57F287)
    .setDescription(
      '𝑪𝒍𝒊𝒄𝒌 𝒕𝒉𝒆 𝒃𝒖𝒕𝒕𝒐𝒏 𝒃𝒆𝒍𝒐𝒘 𝒕𝒐 𝒓𝒆𝒈𝒊𝒔𝒕𝒆𝒓 𝒚𝒐𝒖𝒓 𝒕𝒆𝒂𝒎 𝒇𝒐𝒓 𝒕𝒉𝒆 𝒔𝒄𝒓𝒊𝒎.\n\n' +
      '𝑨𝒇𝒕𝒆𝒓 𝒄𝒐𝒎𝒑𝒍𝒆𝒕𝒊𝒏𝒈 𝒕𝒉𝒆 𝒇𝒐𝒓𝒎 𝒚𝒐𝒖 𝒘𝒊𝒍𝒍 𝒃𝒆 𝒂𝒔𝒌𝒆𝒅 𝒕𝒐 𝒔𝒆𝒍𝒆𝒄𝒕 **4-5** 𝒎𝒆𝒎𝒃𝒆𝒓𝒔 𝒇𝒓𝒐𝒎 𝒂 𝒅𝒓𝒐𝒑 𝒅𝒐𝒘𝒏 𝒎𝒆𝒏𝒖\n\n' +
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n' +
      '𝗚𝗔𝗠𝗜𝗡𝗚 • 𝗦𝗖𝗥𝗜𝗠𝗦'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('register_team_start')
      .setLabel('Register Team')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

module.exports = {
  buildRegisterPanelPayload,
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Post the team registration panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // channel.send instead of interaction.reply — no "used /register"
    // attribution line above a panel players will click for a long time.
    await interaction.channel.send(buildRegisterPanelPayload());
    await interaction.reply({ content: '✅ Panel posted.', flags: MessageFlags.Ephemeral });
  },
};

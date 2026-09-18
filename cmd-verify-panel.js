const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

// Shared with the admin panel (see admin-panel-handlers.js) so "post the
// verification panel" only has one place that defines what it looks like —
// the slash command and the panel button both call this.
function buildVerifyPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('<:276022clydebot:1547663728592420894> 𝐒𝐂𝐑𝐈𝐌𝐒 𝐕𝐄𝐑𝐈𝐅𝐈𝐂𝐀𝐓𝐈𝐎𝐍')
    .setColor(0xF5A623)
    .setDescription(
      '<:559950clipboard:1547663749488312421> 𝑹𝒆𝒂𝒅𝒚 𝒕𝒐 𝒆𝒏𝒕𝒆𝒓 𝒕𝒉𝒆 𝒍𝒐𝒃𝒃𝒚? 𝑽𝒆𝒓𝒊𝒇𝒚 𝒚𝒐𝒖𝒓 𝒔𝒒𝒖𝒂𝒅 𝒂𝒏𝒅 𝒍𝒐𝒄𝒌 𝒚𝒐𝒖𝒓 𝒔𝒑𝒐𝒕 𝒃𝒆𝒇𝒐𝒓𝒆 𝒕𝒉𝒆 𝒔𝒍𝒐𝒕𝒔 𝒓𝒖𝒏 𝒐𝒖𝒕! \n\n' +
      '𝑽𝑬𝑹𝑰𝑭𝑰𝑪𝑨𝑻𝑰𝑶𝑵 𝑺𝑻𝑬𝑷𝑺\n\n' +
      '① 𝑷𝒓𝒆𝒔𝒔 𝑽𝑬𝑹𝑰𝑭𝒀 𝑯𝑬𝑹𝑬 𝒃𝒆𝒍𝒐𝒘\n' +
      '② 𝑨𝒅𝒅 𝒚𝒐𝒖𝒓 𝑻𝒆𝒂𝒎 𝑫𝒆𝒕𝒂𝒊𝒍𝒔\n' +
      '③ 𝑺𝒆𝒍𝒆𝒄𝒕 𝒚𝒐𝒖𝒓 4 𝒑𝒍𝒂𝒚𝒊𝒏𝒈 𝒎𝒆𝒎𝒃𝒆𝒓𝒔\n' +
      '④ 𝑺𝒖𝒃𝒎𝒊𝒕 & 𝒔𝒆𝒄𝒖𝒓𝒆 𝒚𝒐𝒖𝒓 𝒔𝒍𝒐𝒕\n\n' +
      '<a:985581725159669780:1547663774742478878> Everʏ field is required\n\n' +
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n' +
      '𝗡𝗢𝗕𝗟𝗘 𝗚𝗔𝗠𝗜𝗡𝗚 • 𝗦𝗖𝗥𝗜𝗠𝗦'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_start')
      .setLabel('Verify')
      .setEmoji('<a:452028tick:1547663744979574955>')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('verify_edit_start')
      .setLabel('Edit')
      .setEmoji('<:dc992fea7ae84f43b24df2e52282cf6f:1549067424685490186>')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

module.exports = {
  buildVerifyPanelPayload,
  data: new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('Post the team verification panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // channel.send instead of interaction.reply — no "used /verify-panel"
    // attribution line above a panel players will click for a long time.
    await interaction.channel.send(buildVerifyPanelPayload());
    await interaction.reply({ content: '✅ Panel posted.', flags: MessageFlags.Ephemeral });
  },
};

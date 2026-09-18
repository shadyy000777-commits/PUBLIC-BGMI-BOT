const { getGuildStore, saveGuildStore } = require('./storage');
const { buildLiveGroupsPanel } = require('./live-panel-handlers');
const { isPremiumGuild } = require('./premium');

module.exports = {
  name: 'live_panel',
  aliases: ['livepanel'],
  description: "Post a live-updating panel of every group's fill status and match times",
  adminOnly: true,

  async execute(message) {
    if (!isPremiumGuild(message.guildId)) {
      return message.reply('⭐ **live_panel** is a premium feature. Contact the bot owner to upgrade this server.').catch(() => {});
    }

    const store = getGuildStore(message.guildId);
    const sent = await message.channel.send({ embeds: [buildLiveGroupsPanel(store)] });

    // Remember where this panel lives so registrations/slot changes can
    // edit it in place — see refreshLivePanel in live-panel-handlers.js.
    store.settings.livePanelChannelId = sent.channel.id;
    store.settings.livePanelMessageId = sent.id;
    saveGuildStore(message.guildId, store);
  },
};

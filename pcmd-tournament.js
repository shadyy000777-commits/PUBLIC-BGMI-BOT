const { buildTournamentListPayload } = require('./tournament-wizard-handlers');

module.exports = {
  name: 'tournament',
  aliases: ['tourney'],
  description: 'Post the tournament panel — create, switch between, and manage multiple tournaments (usage: !tournament)',
  adminOnly: true,

  async execute(message) {
    const payload = buildTournamentListPayload(message.guildId);
    await message.channel.send(payload);
  },
};

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { buildSlashCommandBodies } = require('./slashCommands');

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID && String(process.env.DISCORD_CLIENT_ID).trim();
const guildId = process.env.GUILD_ID && String(process.env.GUILD_ID).trim();

if (!token || !clientId) {
  console.error('.env에 DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID 가 필요합니다.');
  process.exit(1);
}

const body = buildSlashCommandBodies();
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      console.log(`길드 ${guildId} 슬래시 명령 강제 등록: ${body.map((x) => x.name).join(', ')}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
      console.log('글로벌 슬래시 등록 (반영까지 최대 ~1시간):', body.map((x) => x.name).join(', '));
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

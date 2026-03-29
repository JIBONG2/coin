const { SlashCommandBuilder } = require('discord.js');

/** 이 배열이 길드/글로벌에 PUT 되면 기존 앱 명령 전부 이걸로 덮어씀 */
function buildSlashCommandBodies() {
  return [
    new SlashCommandBuilder()
      .setName('자판기패널')
      .setDescription('쥬코인대행 OTC 자판기 패널을 이 채널에 설치합니다. (서버 관리 권한 또는 최고 관리자만)')
      // 코드에서 ManageGuild | 최고관리자 검사. 기본 제한 없음 → 최고 관리자도 슬래시 목록에서 볼 수 있음
      .setDefaultMemberPermissions(null),
    new SlashCommandBuilder()
      .setName('관리자명령어')
      .setDescription('운영자 관리·송금 한도 (권한별)')
      .setDefaultMemberPermissions(null)
      .addStringOption((opt) =>
        opt
          .setName('명령')
          .setDescription('실행할 작업')
          .setRequired(true)
          .addChoices(
            { name: '운영자 추가 (최고 관리자만)', value: '운영자추가' },
            { name: '운영자 제거 (최고 관리자만)', value: '운영자제거' },
            { name: '1일 송금 한도 설정 (서버 관리·최고 관리자)', value: '송금한도' }
          )
      ),
  ].map((c) => c.toJSON());
}

module.exports = { buildSlashCommandBodies };

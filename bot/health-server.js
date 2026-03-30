const express = require('express');

const app = express();
const PORT = process.env.PORT || 8787;

// 건강검사 엔드포인트
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'ltc-vending-bot'
  });
});

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ 
    message: 'LTC Vending Bot is running',
    status: 'active'
  });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// NOTE:
// 메인 봇 프로세스는 start.sh 에서 별도로 기동합니다.
// 여기서는 health endpoint 전용 서버 역할만 유지합니다.

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

// 30초 후 메인 프로세스 시작
setTimeout(() => {
  console.log('Starting main processes...');
  require('./index.js');
}, 30000);

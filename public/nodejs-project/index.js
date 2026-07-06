/**
 * Capacitor Node.js 入口文件
 * 启动 HTTP 服务器并与 Capacitor 通信
 */

const { channel } = require('bridge');
const http = require('http');

// 设置环境变量
process.env.PORT = process.env.PORT || 3000;
process.env.HOST = '0.0.0.0';

// 等待服务器启动完成后再通知 Capacitor
function waitForServer(port, timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkInterval = 100;

    function check() {
      const req = http.get(`http://localhost:${port}/api/app/version`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error('Server startup timeout'));
        } else {
          setTimeout(check, checkInterval);
        }
      });
    }
    check();
  });
}

// 启动服务器
console.log('[Node.js] Starting server...');
require('./server.js');

// 等待服务器就绪后通知 Capacitor
waitForServer(process.env.PORT, 10000).then(() => {
  console.log('[Node.js] Server ready on port ' + process.env.PORT);
  channel.send('server-ready', {
    port: process.env.PORT,
    url: `http://localhost:${process.env.PORT}`
  });
}).catch((err) => {
  console.error('[Node.js] Server startup failed:', err.message);
  channel.send('server-error', { error: err.message });
});

// 监听来自 Capacitor 的消息
channel.addListener('ping', (data) => {
  channel.send('pong', { timestamp: Date.now() });
});

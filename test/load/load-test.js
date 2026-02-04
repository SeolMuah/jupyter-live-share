/* load-test.js - WebSocket load test for 50 concurrent clients */
/* Usage: node test/load/load-test.js [--url ws://localhost:3000] [--clients 50] */

const WebSocket = require('ws');

// Parse args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const WS_URL = getArg('--url', 'ws://localhost:3000');
const CLIENT_COUNT = parseInt(getArg('--clients', '50'), 10);
const PIN = getArg('--pin', '') || undefined;

console.log(`\n=== Jupyter Live Share Load Test ===`);
console.log(`URL: ${WS_URL}`);
console.log(`Clients: ${CLIENT_COUNT}`);
console.log(`PIN: ${PIN || 'none'}\n`);

// Stats
const stats = {
  connected: 0,
  failed: 0,
  messagesReceived: 0,
  messageLatencies: [],
  startTime: Date.now(),
};

const clients = [];

// Create clients
for (let i = 0; i < CLIENT_COUNT; i++) {
  createClient(i);
}

function createClient(id) {
  const ws = new WebSocket(WS_URL);
  const clientStats = { id, connected: false, messages: 0, joinTime: Date.now() };

  ws.on('open', () => {
    clientStats.connected = true;
    clientStats.connectTime = Date.now() - clientStats.joinTime;
    stats.connected++;

    // Send join
    ws.send(JSON.stringify({ type: 'join', data: { pin: PIN } }));

    if (stats.connected % 10 === 0) {
      console.log(`  ${stats.connected}/${CLIENT_COUNT} connected`);
    }

    if (stats.connected === CLIENT_COUNT) {
      console.log(`\nAll ${CLIENT_COUNT} clients connected!`);
      console.log(`Average connect time: ${getAvgConnectTime()}ms\n`);
      console.log('Listening for messages... (press Ctrl+C to stop)\n');
    }
  });

  ws.on('message', (data) => {
    clientStats.messages++;
    stats.messagesReceived++;

    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'join:result' && !msg.data.success) {
        console.log(`  Client ${id}: join failed - ${msg.data.error}`);
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('error', (err) => {
    if (!clientStats.connected) {
      stats.failed++;
      console.log(`  Client ${id}: connection failed - ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (clientStats.connected) {
      stats.connected--;
    }
  });

  clients.push({ ws, stats: clientStats });
}

function getAvgConnectTime() {
  const times = clients.filter(c => c.stats.connectTime).map(c => c.stats.connectTime);
  if (times.length === 0) return 0;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

// Print stats every 5s
const interval = setInterval(() => {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const totalMsgs = clients.reduce((sum, c) => sum + c.stats.messages, 0);

  console.log(`[${elapsed}s] Connected: ${stats.connected}/${CLIENT_COUNT} | Failed: ${stats.failed} | Messages: ${totalMsgs}`);
}, 5000);

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n\n=== Final Report ===');
  console.log(`Duration: ${((Date.now() - stats.startTime) / 1000).toFixed(1)}s`);
  console.log(`Connected: ${stats.connected}/${CLIENT_COUNT}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Total messages received: ${stats.messagesReceived}`);
  console.log(`Avg messages per client: ${Math.round(stats.messagesReceived / Math.max(stats.connected, 1))}`);
  console.log(`Avg connect time: ${getAvgConnectTime()}ms`);

  // Memory usage
  const mem = process.memoryUsage();
  console.log(`Memory (test process): ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
  console.log('');

  clearInterval(interval);
  clients.forEach(c => c.ws.close());

  setTimeout(() => process.exit(0), 1000);
});

#!/usr/bin/env node
/**
 * Simple test client for the MHNOS Runtime Bridge
 * Usage: node test-client.js [ws://localhost:18790]
 */

import WebSocket from 'ws';

const url = process.argv[2] || 'ws://localhost:18790';

console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('Connected!');
  
  // Send status request
  ws.send(JSON.stringify({
    type: 'status',
    id: 'test-1',
  }));
  
  // Test spawning a simple node process
  setTimeout(() => {
    console.log('Spawning test process...');
    ws.send(JSON.stringify({
      type: 'spawn',
      id: 'test-2',
      processType: 'node',
      command: '-e',
      args: ['console.log("Hello from runtime!"); setTimeout(() => console.log("Done"), 1000);'],
      options: {},
    }));
  }, 1000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received:', JSON.stringify(msg, null, 2));
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
});

ws.on('close', () => {
  console.log('Disconnected');
  process.exit(0);
});

// Close after 10 seconds
setTimeout(() => {
  ws.close();
}, 10000);

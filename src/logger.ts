import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Write streams for the logs
const infoStream = fs.createWriteStream(path.join(logsDir, 'info.log'), { flags: 'a' });
const errorStream = fs.createWriteStream(path.join(logsDir, 'error.log'), { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;

// Helper to format arguments like console.log does
function formatArgs(args: any[]) {
  return util.format(...args);
}

// Override console.log
console.log = function (...args) {
  const timestamp = new Date().toISOString();
  const message = formatArgs(args);
  infoStream.write(`[${timestamp}] [INFO] ${message}\n`);
  
  // Still print to the terminal
  originalLog.apply(console, args);
};

// Override console.error
console.error = function (...args) {
  const timestamp = new Date().toISOString();
  const message = formatArgs(args);
  errorStream.write(`[${timestamp}] [ERROR] ${message}\n`);
  
  // Also write errors to the info log so we have a unified timeline
  infoStream.write(`[${timestamp}] [ERROR] ${message}\n`);
  
  // Still print to the terminal
  originalError.apply(console, args);
};

export {};

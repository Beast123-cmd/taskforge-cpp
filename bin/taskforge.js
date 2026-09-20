#!/usr/bin/env node
const http = require('http');
const { existsSync, readFileSync, unlinkSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');
const { tmpdir } = require('os');

const root = join(__dirname, '..');
const binary = join(root, 'build', 'taskforge_demo');

function build() {
  if (existsSync(binary)) return;
  const result = spawnSync('c++', ['-std=c++17', '-O2', '-pthread', '-Iinclude', 'src/JobScheduler.cpp', 'src/main.cpp', '-o', binary], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not compile TaskForge. Install a C++17 compiler.\n${result.stderr}`);
}

function runDemo() {
  build();
  const file = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(binary, { input: `demo\nrun\nexport-json ${file}\nquit\n`, encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) throw new Error(result.stderr || 'TaskForge engine did not produce telemetry.');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  unlinkSync(file);
  return data;
}

const html = readFileSync(join(root, 'web', 'index.html'));
const server = http.createServer((request, response) => {
  if (request.url === '/api/demo') {
    try { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify(runDemo())); }
    catch (error) { response.writeHead(500, {'Content-Type':'application/json'}); response.end(JSON.stringify({error: error.message})); }
    return;
  }
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  response.end(html);
});

server.listen(4173, () => console.log('TaskForge dashboard: http://localhost:4173'));

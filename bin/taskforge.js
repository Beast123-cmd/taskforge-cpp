#!/usr/bin/env node
const http = require('http');
const { existsSync, mkdirSync, readFileSync, unlinkSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');
const { tmpdir } = require('os');

const root = join(__dirname, '..');
const binary = join(root, 'build', 'taskforge_demo');
const [command, argument] = process.argv.slice(2);

function build() {
  if (existsSync(binary)) return;
  mkdirSync(join(root, 'build'), { recursive: true });
  const result = spawnSync('c++', ['-std=c++17', '-O2', '-pthread', '-Iinclude', 'src/JobScheduler.cpp', 'src/main.cpp', '-o', binary], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not compile TaskForge. Install a C++17 compiler.\n${result.stderr}`);
}

function workflowInput(path) {
  const workflow = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(workflow.jobs)) throw new Error('Workflow JSON requires a jobs array.');
  return workflow.jobs.map(job => {
    if (!job.id || !job.command) throw new Error('Every job needs id and command.');
    const priority = job.priority || 'medium';
    const dependencies = (job.dependsOn || []).join(',') || '-';
    return `add-command ${job.id} ${priority} ${dependencies} ${job.retries || 0} ${job.command}`;
  }).join('\n') + '\n';
}

function terminalRun(path) {
  build();
  const input = `${workflowInput(path)}graph\nrun\ngraph\nevents\nquit\n`;
  const result = spawnSync(binary, { input, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exitCode = result.status || 0;
}

function telemetry(path) {
  build();
  const file = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const input = `${path ? workflowInput(path) : 'demo\n'}run\nexport-json ${file}\nquit\n`;
  const result = spawnSync(binary, { input, encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) throw new Error(result.stderr || 'TaskForge engine did not produce telemetry.');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  unlinkSync(file);
  return data;
}

function dashboard(path) {
  const html = readFileSync(join(root, 'web', 'index.html'));
  http.createServer((request, response) => {
    if (request.url === '/api/demo') {
      try { const body = JSON.stringify(telemetry(path)); response.writeHead(200, {'Content-Type':'application/json'}); response.end(body); }
      catch (error) { response.writeHead(500, {'Content-Type':'application/json'}); response.end(JSON.stringify({error: error.message})); }
      return;
    }
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end(html);
  }).listen(4173, () => console.log('Optional dashboard: http://localhost:4173'));
}

try {
  if (!command) {
    build();
    process.exitCode = spawnSync(binary, { cwd: root, stdio: 'inherit' }).status || 0;
  } else if (command === 'run' && argument) {
    terminalRun(argument);
  } else if (command === 'dashboard') {
    dashboard(argument);
  } else {
    console.log('Usage: taskforge | taskforge run <workflow.json> | taskforge dashboard [workflow.json]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`TaskForge: ${error.message}`);
  process.exitCode = 1;
}

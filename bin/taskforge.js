#!/usr/bin/env node
const http = require('http');
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { spawn, spawnSync } = require('child_process');
const { join } = require('path');
const { tmpdir } = require('os');
const { collect } = require('../lib/process-collector');
const { render, visibleProcesses } = require('../lib/terminal-ui');
const readline = require('readline');
const { createTrace, applyEvent, renderTrace } = require('../lib/workflow-trace');
const { loadRun, listRuns, workerTimeline, timelineChart } = require('../lib/run-history');

const root = join(__dirname, '..');
let binary = join(root, 'build', process.platform === 'win32' ? 'taskforge_demo.exe' : 'taskforge_demo');
const [command, argument] = process.argv.slice(2);

function build() {
  if (existsSync(binary)) return;
  const releaseBinary = join(root, 'build', 'Release', 'taskforge_demo.exe');
  if (existsSync(releaseBinary)) { binary = releaseBinary; return; }
  if (process.platform === 'win32') {
    const configured = spawnSync('cmake', ['-S', '.', '-B', 'build'], { cwd: root, encoding: 'utf8' });
    const compiled = configured.status === 0 && spawnSync('cmake', ['--build', 'build', '--config', 'Release'], { cwd: root, encoding: 'utf8' });
    if (!compiled || compiled.status !== 0) throw new Error(`Could not compile TaskForge. Install CMake and a C++17 compiler.\n${configured.stderr || compiled?.stderr || ''}`);
    binary = existsSync(releaseBinary) ? releaseBinary : binary;
    if (!existsSync(binary)) throw new Error('CMake did not produce taskforge_demo.exe.');
    return;
  }
  mkdirSync(join(root, 'build'), { recursive: true });
  const result = spawnSync('c++', ['-std=c++17', '-O2', '-pthread', '-Iinclude', 'src/JobScheduler.cpp', 'src/ProcessRunner.cpp', 'src/main.cpp', '-o', binary], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not compile TaskForge. Install a C++17 compiler.\n${result.stderr}`);
}

function workflowJobs(path) {
  const workflow = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(workflow.jobs)) throw new Error('Workflow JSON requires a jobs array.');
  return workflow.jobs;
}

function workflowInput(jobs) {
  const ids = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || typeof job.id !== 'string') throw new Error('Every job needs a string id.');
    if (ids.has(job.id)) throw new Error(`Duplicate job ID: ${job.id}`);
    ids.add(job.id);
  }
  return jobs.map(job => {
    if (!job.id || !/^[A-Za-z0-9_-]+$/.test(job.id)) throw new Error('Job IDs must use letters, numbers, _ or -.');
    if ((job.command !== undefined) === (job.executable !== undefined)) {
      throw new Error(`Job ${job.id} needs exactly one of command or executable.`);
    }
    const hasCommand = typeof job.command === 'string' && job.command.trim().length > 0;
    const hasExecutable = typeof job.executable === 'string' && job.executable.trim().length > 0;
    if (!hasCommand && !hasExecutable) throw new Error(`Job ${job.id} has an invalid command or executable.`);
    if (hasCommand && /[\r\n\0]/.test(job.command)) throw new Error(`Command for job ${job.id} must be one line without NUL bytes.`);
    if (hasExecutable && (job.args !== undefined && !Array.isArray(job.args) ||
        (job.args || []).some(arg => typeof arg !== 'string' || arg.includes('\0')) || job.executable.includes('\0'))) {
      throw new Error(`Invalid executable or args for job ${job.id}.`);
    }
    if (job.dependsOn !== undefined && (!Array.isArray(job.dependsOn) || job.dependsOn.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)))) {
      throw new Error(`Invalid dependencies for job ${job.id}.`);
    }
    for (const dependency of job.dependsOn || []) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} for job ${job.id}.`);
    }
    const priority = job.priority || 'medium';
    if (!['high', 'medium', 'low'].includes(priority)) throw new Error(`Invalid priority for job ${job.id}.`);
    if (!Number.isInteger(job.retries ?? 0) || (job.retries ?? 0) < 0 || (job.retries ?? 0) > 4294967295) throw new Error(`Invalid retries for job ${job.id}.`);
    const dependencies = (job.dependsOn || []).join(',') || '-';
    if (hasExecutable) {
      const encode = value => Buffer.from(value, 'utf8').toString('hex') || '-';
      const values = [job.executable, ...(job.args || [])].map(encode).join(' ');
      return `add-exec ${job.id} ${priority} ${dependencies} ${job.retries || 0} ${values}`;
    }
    return `add-command ${job.id} ${priority} ${dependencies} ${job.retries || 0} ${job.command}`;
  }).join('\n') + '\n';
}

function terminalRun(path) {
  const workflow = workflowInput(workflowJobs(path));
  build();
  const exportFile = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const input = `${workflow}graph\nrun\ngraph\ntimeline\nevents\nexport-json ${exportFile}\nquit\n`;
  const result = spawnSync(binary, { input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status === 0 && existsSync(exportFile)) {
    const data = JSON.parse(readFileSync(exportFile, 'utf8'));
    unlinkSync(exportFile);
    console.log(`Run artifacts saved to ${saveRun(path, data)}`);
    if (data.jobs.some(job => job.state !== 'COMPLETED')) process.exitCode = 1;
  } else {
    process.exitCode = result.status || 1;
  }
}

function saveRun(path, data) {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDirectory = join(process.cwd(), '.taskforge', 'runs', runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({ id: runId, createdAt: new Date().toISOString(), workflow: path, jobs: data.jobs }, null, 2));
  writeFileSync(join(runDirectory, 'events.jsonl'), data.events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(join(runDirectory, 'metrics.json'), JSON.stringify(data.metrics, null, 2));
  return runDirectory;
}

function runsDirectory() {
  return join(process.cwd(), '.taskforge', 'runs');
}

function showRuns() {
  const runs = listRuns(runsDirectory());
  if (!runs.length) return console.log('No saved runs here. Run: taskforge trace <workflow.json>');
  console.log('SAVED WORKFLOW RUNS');
  for (const run of runs) {
    console.log(`${run.id}  ${run.error ? `UNREADABLE: ${run.error}` : `${run.completed}/${run.total} completed  ${run.failed ? `${run.failed} failed/cancelled` : 'success'}  ${run.workflow}`}`);
  }
}

function showRun(id) {
  const { run, metrics, events } = loadRun(runsDirectory(), id);
  console.log(`RUN ${id}\nCreated: ${run.createdAt}\nWorkflow: ${run.workflow}\nJobs: ${metrics.completed}/${run.jobs.length} completed  Failed: ${metrics.failed}  Retries: ${metrics.retries}  Peak workers: ${metrics.peakRunning}\nEvents: ${events.length}`);
  console.log('\nDEPENDENCY GRAPH AND FINAL STATES');
  for (const job of run.jobs) {
    console.log(`  [${job.state.padEnd(9)}] ${job.id}  ←  ${(job.dependencies || []).join(', ') || 'entry'}`);
  }
  console.log('\nWORKER TIMELINE');
  const spans = workerTimeline(events);
  if (!spans.length) console.log('  No worker execution recorded.');
  else for (const line of timelineChart(spans)) console.log(`  ${line}`);
  for (const span of spans) {
    console.log(`  W${span.workerId}  ${String(span.startMs).padStart(6)}–${String(span.endMs).padEnd(6)} ms  ${String(span.durationMs).padStart(5)} ms  ${span.jobId}  ${span.outcome}`);
  }
  console.log(`\nReplay without executing commands: taskforge replay ${id}`);
}

function replayRun(id, speedText) {
  const { run, events } = loadRun(runsDirectory(), id);
  const speed = speedText === undefined ? 1 : Number(speedText);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 20) throw new Error('Replay speed must be between 0.25 and 20.');
  const jobs = run.jobs.map(job => ({ id: job.id, dependsOn: job.dependencies }));
  const totalMs = events.at(-1)?.elapsedMs || 0;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let trace = createTrace(jobs);
  let index = 0;
  let cursorMs = 0;
  let playbackSpeed = speed;
  let paused = false;
  let lastTick = Date.now();
  let timer;
  let finished = false;
  const draw = () => {
    trace.playback = { cursorMs: Math.round(cursorMs), totalMs, speed: playbackSpeed,
      paused, index, totalEvents: events.length };
    if (interactive) process.stdout.write(`\x1b[H\x1b[2J${renderTrace(trace, process.stdout.columns, process.stdout.rows)}`);
  };
  const consume = () => {
    while (index < events.length && events[index].elapsedMs <= cursorMs) {
      applyEvent(trace, events[index]);
      if (!interactive) console.log(`${String(events[index].elapsedMs).padStart(6)} ms  ${events[index].jobId.padEnd(18)} ${events[index].state}`);
      index++;
    }
    if (interactive && index === events.length) paused = true;
    draw();
    if (!interactive && index === events.length) finish();
  };
  const rebuild = target => {
    const scroll = trace.scroll;
    trace = createTrace(jobs);
    trace.scroll = scroll;
    index = 0;
    cursorMs = target ? events[target - 1].elapsedMs : 0;
    while (index < target) applyEvent(trace, events[index++]);
    draw();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    process.removeListener('SIGINT', finish);
    if (interactive) {
      process.stdout.removeListener('resize', draw);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
    console.log(`Replay complete: ${events.length} recorded events from ${id}. No commands were executed.`);
  };
  const onKey = (text, key) => {
    if (text === 'q' || key?.ctrl && key.name === 'c') return finish();
    if (text === ' ') paused = !paused;
    else if (key?.name === 'right') { paused = true; rebuild(Math.min(events.length, index + 1)); }
    else if (key?.name === 'left') { paused = true; rebuild(Math.max(0, index - 1)); }
    else if (key?.name === 'up') trace.scroll = Math.max(0, trace.scroll - 1);
    else if (key?.name === 'down') trace.scroll = Math.min(Math.max(0, jobs.length - 1), trace.scroll + 1);
    else if (text === '+') playbackSpeed = Math.min(20, playbackSpeed * 2);
    else if (text === '-') playbackSpeed = Math.max(0.25, playbackSpeed / 2);
    lastTick = Date.now();
    draw();
  };
  if (interactive) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    process.stdout.on('resize', draw);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  }
  process.once('SIGINT', finish);
  consume();
  if (finished) return;
  timer = setInterval(() => {
    const now = Date.now();
    if (paused) { lastTick = now; return; }
    cursorMs = Math.min(totalMs, cursorMs + (now - lastTick) * playbackSpeed);
    lastTick = now;
    consume();
  }, 50);
}

function traceWorkflow(path) {
  const jobs = workflowJobs(path);
  const input = workflowInput(jobs);
  build();
  const trace = createTrace(jobs);
  const exportFile = join(tmpdir(), `taskforge-trace-${process.pid}-${Date.now()}.json`);
  const child = spawn(binary, { stdio: ['pipe', 'pipe', 'pipe'] });
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let stderr = '';
  let interrupted = false;
  const draw = () => process.stdout.write(`\x1b[H\x1b[2J${renderTrace(trace, process.stdout.columns, process.stdout.rows)}`);
  if (interactive) {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.stdout.on('resize', draw);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    draw();
  }
  function onKey(text, key) {
    if (key?.ctrl && key.name === 'c' || text === 'q') return stop();
    if (key?.name === 'up') trace.scroll = Math.max(0, trace.scroll - 1);
    if (key?.name === 'down') trace.scroll = Math.min(Math.max(0, trace.jobs.length - 1), trace.scroll + 1);
    draw();
  }
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const clean = line.replace(/^(?:taskforge>\s*)+/, '');
    const marker = clean.indexOf('TFTRACE\t');
    if (marker < 0) {
      if (clean && !clean.startsWith('Added ') && !clean.startsWith('Wrote scheduler data')) {
        trace.logs.push(clean);
        if (trace.logs.length > 50) trace.logs.shift();
        if (interactive) draw();
        else console.log(clean);
      }
      return;
    }
    try {
      const event = JSON.parse(clean.slice(marker + 8));
      applyEvent(trace, event);
      if (interactive) draw();
      else console.log(`${String(event.elapsedMs).padStart(6)} ms  ${(event.workerId ? `W${event.workerId}` : 'scheduler').padEnd(9)} ${event.jobId.padEnd(18)} ${event.state.padEnd(10)} ${event.message}`);
    } catch (error) {
      stderr += `Invalid scheduler event: ${error.message}\n`;
    }
  });
  child.stdin.end(`${input}trace\nexport-json ${exportFile}\nquit\n`);
  const stop = () => { interrupted = true; child.kill('SIGINT'); };
  process.once('SIGINT', stop);
  child.on('error', error => { stderr += `${error.message}\n`; });
  child.on('close', code => {
    process.removeListener('SIGINT', stop);
    if (interactive) {
      process.stdout.removeListener('resize', draw);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
    if (existsSync(exportFile)) {
      const data = JSON.parse(readFileSync(exportFile, 'utf8'));
      unlinkSync(exportFile);
      const failed = data.jobs.some(job => job.state !== 'COMPLETED');
      console.log(`Workflow ${failed ? 'failed or incomplete' : 'completed'}: ${data.metrics.completed}/${data.metrics.submitted} jobs completed, peak ${data.metrics.peakRunning} concurrent workers.`);
      console.log(`Trace saved to ${saveRun(path, data)}`);
      if (failed || code) process.exitCode = code || 1;
    } else {
      console.error(`TaskForge: workflow trace did not complete.${stderr ? `\n${stderr.trim()}` : ''}`);
      process.exitCode = code || 1;
    }
    if (interrupted) process.exitCode = 130;
  });
}

function telemetry(path) {
  build();
  const file = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const input = `${path ? workflowInput(workflowJobs(path)) : 'demo\n'}run\nexport-json ${file}\nquit\n`;
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

// Read the operating system process table. This is observation-only: unlike
// scheduler jobs, existing processes have no TaskForge dependency metadata.
function monitor() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The live monitor needs an interactive terminal. Use taskforge snapshot for JSON output.');
  }
  const sessionId = `monitor-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const sessionDirectory = join(process.cwd(), '.taskforge', 'monitor', sessionId);
  const snapshotsFile = join(sessionDirectory, 'snapshots.jsonl');
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, 'session.json'), JSON.stringify({ id: sessionId, platform: process.platform, startedAt: new Date().toISOString(), status: 'running' }, null, 2));
  const state = { history: new Map(), systemHistory: [], filter: '', sort: 'cpu', selected: 0,
    scroll: 0, view: 'table', paused: false, inputMode: false, message: '' };
  let collectorState = null;
  let snapshot = null;
  let interval;
  let finished = false;
  const draw = () => {
    if (!snapshot) return;
    process.stdout.write(`\x1b[H\x1b[2J${render(snapshot, state, process.stdout.columns, process.stdout.rows)}`);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(interval);
    writeFileSync(join(sessionDirectory, 'session.json'), JSON.stringify({ id: sessionId, platform: process.platform, endedAt: new Date().toISOString(), status: 'completed' }, null, 2));
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.log(`\nSaved live monitoring session: ${sessionDirectory}`);
  };
  const sample = () => {
    if (state.paused) return;
    try {
      const result = collect(collectorState);
      collectorState = result.state;
      snapshot = result.snapshot;
      state.systemHistory.push(snapshot.systemCpuPercent || 0);
      state.systemHistory = state.systemHistory.slice(-120);
      const active = new Set(snapshot.processes.map(process => process.identity));
      for (const identity of state.history.keys()) if (!active.has(identity)) state.history.delete(identity);
      for (const process of snapshot.processes) {
        state.history.set(process.identity, [...(state.history.get(process.identity) || []), process.cpuPercent].slice(-10));
      }
      appendFileSync(snapshotsFile, JSON.stringify({ ...snapshot, processes: snapshot.processes.slice(0, 25) }) + '\n');
      const count = visibleProcesses(snapshot, state.filter, state.sort).length;
      state.selected = Math.min(state.selected, Math.max(0, count - 1));
      draw();
    } catch (error) {
      state.paused = true;
      state.message = `Collection error: ${error.message}`;
      draw();
    }
  };
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.on('keypress', (text, key) => {
    if (key?.ctrl && key.name === 'c' || !state.inputMode && key?.name === 'q') return finish();
    if (state.inputMode) {
      if (key?.name === 'return') state.inputMode = false;
      else if (key?.name === 'escape') { state.inputMode = false; state.filter = ''; }
      else if (key?.name === 'backspace') state.filter = state.filter.slice(0, -1);
      else if (text && !key?.ctrl && text.length === 1) state.filter += text;
      state.selected = 0;
      state.scroll = 0;
    } else if (key?.name === 'up' || key?.name === 'down') {
      const count = visibleProcesses(snapshot, state.filter, state.sort).length;
      state.selected = Math.max(0, Math.min(count - 1, state.selected + (key.name === 'up' ? -1 : 1)));
      const bodyHeight = Math.max(2, (process.stdout.rows || 30) - 12);
      if (state.selected < state.scroll) state.scroll = state.selected;
      if (state.selected >= state.scroll + bodyHeight) state.scroll = state.selected - bodyHeight + 1;
    } else if (text === '/') { state.inputMode = true; state.filter = ''; }
    else if (text === 'c') { state.sort = 'cpu'; state.selected = 0; state.scroll = 0; }
    else if (text === 'm') { state.sort = 'memory'; state.selected = 0; state.scroll = 0; }
    else if (text === 'i') { state.sort = 'pid'; state.selected = 0; state.scroll = 0; }
    else if (text === 't') state.view = state.view === 'table' ? 'tree' : 'table';
    else if (text === ' ') state.paused = !state.paused;
    draw();
  });
  process.stdout.on('resize', draw);
  process.on('SIGINT', finish);
  sample();
  interval = setInterval(sample, 2000);
}

function listSessions() {
  const directory = join(process.cwd(), '.taskforge', 'monitor');
  if (!existsSync(directory)) return console.log('No monitor sessions recorded yet. Run: taskforge monitor');
  console.log('MONITOR SESSIONS');
  for (const session of readdirSync(directory).filter(name => name.startsWith('monitor-')).sort().reverse()) console.log(`  ${session}`);
}

function inspectSession(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id || '')) throw new Error('Invalid session id.');
  const snapshots = readFileSync(join(process.cwd(), '.taskforge', 'monitor', id, 'snapshots.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!snapshots.length) throw new Error('Session contains no snapshots.');
  const first = snapshots[0];
  const last = snapshots.at(-1);
  const systemCpu = last.systemCpuPercent ?? last.systemCpu;
  console.log(`SESSION ${id}\nSnapshots: ${snapshots.length}\nStarted: ${first.capturedAt}\nLatest: ${last.capturedAt}\nLatest system CPU: ${systemCpu == null ? 'n/a' : systemCpu.toFixed(1) + '%'}\n\nLatest busy processes:`);
  for (const process of (last.processes || last.topProcesses).slice(0, 10)) console.log(`  ${process.pid.padStart(6)}  ${(process.cpuPercent ?? process.cpu).toFixed(1).padStart(6)}%  ${process.command}`);
}

try {
  if (!command) {
    build();
    process.exitCode = spawnSync(binary, { stdio: 'inherit' }).status || 0;
  } else if (command === 'run' && argument) {
    terminalRun(argument);
  } else if (command === 'trace' && argument) {
    traceWorkflow(argument);
  } else if (command === 'runs') {
    showRuns();
  } else if (command === 'show' && argument) {
    showRun(argument);
  } else if (command === 'replay' && argument) {
    if (process.argv[4] && process.argv[4] !== '--speed') throw new Error('Usage: taskforge replay <run-id> [--speed <factor>]');
    if (process.argv[4] === '--speed' && !process.argv[5]) throw new Error('Replay speed is missing.');
    replayRun(argument, process.argv[5]);
  } else if (command === 'monitor') {
    monitor();
  } else if (command === 'snapshot') {
    const baseline = collect();
    setTimeout(() => {
      try {
        const { snapshot } = collect(baseline.state);
        console.log(JSON.stringify({ ...snapshot, processes: snapshot.processes.slice(0, 25) }, null, 2));
      } catch (error) {
        console.error(`TaskForge: ${error.message}`);
        process.exitCode = 1;
      }
    }, 1000);
  } else if (command === 'sessions') {
    listSessions();
  } else if (command === 'inspect' && argument) {
    inspectSession(argument);
  } else if (command === 'dashboard') {
    dashboard(argument);
  } else {
    console.log('Usage: taskforge | taskforge run <workflow.json> | taskforge trace <workflow.json> | taskforge runs | taskforge show <run-id> | taskforge replay <run-id> [--speed <factor>] | taskforge monitor | taskforge snapshot | taskforge sessions | taskforge inspect <session-id> | taskforge dashboard [workflow.json]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`TaskForge: ${error.message}`);
  process.exitCode = 1;
}

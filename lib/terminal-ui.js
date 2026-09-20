const BLOCKS = '▁▂▃▄▅▆▇█';

function sparkline(values, maximum = 100) {
  return values.map(value => BLOCKS[Math.min(7, Math.max(0, Math.round(value / maximum * 7)))]).join('');
}

function clip(value, width) {
  if (width <= 0) return '';
  const text = String(value);
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function visibleProcesses(snapshot, filter, sort) {
  const query = filter.toLowerCase();
  const rows = snapshot.processes.filter(process =>
    !query || process.command.toLowerCase().includes(query) || process.pid.includes(query));
  if (sort === 'memory') rows.sort((a, b) => b.memoryBytes - a.memoryBytes);
  if (sort === 'pid') rows.sort((a, b) => Number(a.pid) - Number(b.pid));
  return rows;
}

function treeRows(processes, selected) {
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const rows = [];
  const ancestors = [];
  const seen = new Set();
  for (let current = selected; current && !seen.has(current.pid); current = byPid.get(current.ppid)) {
    ancestors.unshift(current);
    seen.add(current.pid);
  }
  ancestors.forEach((process, depth) => rows.push({ process, prefix: `${'  '.repeat(depth)}${depth ? '└─ ' : ''}` }));
  const children = processes.filter(process => process.ppid === selected.pid)
    .sort((a, b) => b.cpuPercent - a.cpuPercent);
  children.forEach((process, index) => rows.push({ process, prefix: `${'  '.repeat(ancestors.length)}${index === children.length - 1 ? '└─ ' : '├─ '}` }));
  return rows;
}

// A pure renderer makes resizing and narrow terminals testable without a TTY.
function render(snapshot, state, columns = 100, rows = 30) {
  const width = Math.max(48, columns);
  const height = Math.max(14, rows);
  const processes = visibleProcesses(snapshot, state.filter, state.sort);
  const selected = processes[Math.min(state.selected, processes.length - 1)];
  const system = snapshot.systemCpuPercent;
  const graph = sparkline(state.systemHistory.slice(-Math.max(1, width - 39)));
  const lines = [
    clip(`TASKFORGE  •  LIVE ${snapshot.platform.toUpperCase()} PROCESSES  •  ${snapshot.capturedAt}`, width),
    '─'.repeat(width),
    clip(`SYSTEM CPU ${system == null ? 'n/a' : system.toFixed(1) + '%'}  ${graph}`, width),
    clip(`Processes ${snapshot.processes.length}  Showing ${processes.length}  Sort ${state.sort}  ${state.paused ? 'PAUSED' : 'LIVE'}  Filter ${state.filter || 'none'}`, width),
    '─'.repeat(width),
  ];
  const bodyHeight = height - 12;
  if (state.view === 'tree' && selected) {
    lines.push(clip('PROCESS ANCESTRY AND DIRECT CHILDREN', width));
    const tree = treeRows(snapshot.processes, selected);
    for (const { process, prefix } of tree.slice(0, bodyHeight)) {
      lines.push(clip(`${process.identity === selected.identity ? '▶' : ' '} ${prefix}${process.pid} ${process.command}  ${process.cpuPercent.toFixed(1)}%`, width));
    }
  } else {
    lines.push(clip('   PID     PPID    CPU%   RSS MiB  CPU TREND    COMMAND', width));
    const start = Math.max(0, Math.min(state.scroll, Math.max(0, processes.length - bodyHeight)));
    for (let index = start; index < Math.min(start + bodyHeight, processes.length); index++) {
      const process = processes[index];
      const trend = sparkline(state.history.get(process.identity) || []);
      lines.push(clip(`${index === state.selected ? '▶' : ' '} ${process.pid.padStart(6)}  ${process.ppid.padStart(6)}  ${process.cpuPercent.toFixed(1).padStart(6)}  ${(process.memoryBytes / 1048576).toFixed(1).padStart(7)}  ${trend.padEnd(10)}  ${process.command}`, width));
    }
  }
  while (lines.length < height - 5) lines.push('');
  lines.push('─'.repeat(width));
  if (selected) {
    lines.push(clip(`SELECTED ${selected.pid}  CPU ${selected.cpuPercent.toFixed(1)}%  RSS ${(selected.memoryBytes / 1048576).toFixed(1)} MiB  Parent ${selected.ppid}`, width));
    lines.push(clip(`Started ${selected.startedAt}  ${selected.command}`, width));
  } else {
    lines.push(clip('No processes match this filter.', width), '');
  }
  lines.push(clip(state.inputMode ? `FILTER: ${state.filter}_  Enter apply  Esc cancel` : '↑↓ select  c CPU  m memory  i PID  t tree/table  / filter  Space pause  q quit', width));
  lines.push(clip(state.message || 'Real OS ancestry is not a workflow dependency graph.', width));
  return lines.slice(0, height).join('\n');
}

module.exports = { render, visibleProcesses, treeRows, clip };

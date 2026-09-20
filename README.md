# TaskForge

TaskForge is a local-first C++17 scheduling and concurrency observability tool. It runs dependency-aware command workflows on reusable worker threads, records why every scheduling decision occurred, and provides a cross-platform terminal process observatory.

```text
Workflow JSON --> TaskForge CLI --> C++ Scheduler --> worker threads --> command processes
                      |                 |
                      |                 +--> dependency DAG / priority queue / event audit trail
                      +--> live OS process topology and CPU telemetry
```

## What it does

- Priority scheduling with deterministic FIFO ordering for equal priorities
- Dependency DAGs, cycle detection, blocked-job propagation, retries, and failure cancellation
- Reusable `std::thread` worker pool with condition-variable wakeups and graceful shutdown
- Structured scheduler event audit trail: submitted, blocked, ready, running, retrying, failed, completed
- Terminal graph, status table, execution metrics, and decision timeline for every TaskForge workflow
- Read-only live process observatory: sampled system CPU, process CPU history, memory use, and parent → child topology
- macOS, Linux, and Windows process collectors; C++ build/test CI targets all three platforms

## Install

```sh
npm install -g github:Beast123-cmd/taskforge-cpp
taskforge
```

This opens the interactive terminal console. It needs Node.js 18+ and a C++17 compiler. Update an existing installation with `npm install -g github:Beast123-cmd/taskforge-cpp --force`.

## Run a real workflow

```sh
taskforge run examples/cpu-workflow.json
```

Each command is a real child process executed by a C++ worker thread. The terminal automatically prints the graph before and after execution, job table, metrics, and decision trace.

Every `taskforge run` also creates a durable local record:

```text
.taskforge/runs/run-<timestamp>/
├── run.json        workflow identity and final job states
├── events.jsonl    append-friendly scheduler event history
└── metrics.json    final aggregate metrics
```

Events include the responsible worker ID when applicable, allowing the terminal timeline to show which worker ran each task and for how long.

```json
{
  "jobs": [
    { "id": "build", "priority": "high", "command": "npm run build" },
    { "id": "test", "priority": "medium", "dependsOn": ["build"], "retries": 1, "command": "npm test" }
  ]
}
```

`id` and `command` are required. `priority` defaults to `medium`, `dependsOn` to an empty list, and `retries` to `0`. Commands run through the host shell: only run trusted workflow files.

## Observe the host machine

```sh
taskforge monitor
```

The observatory refreshes every two seconds. It shows sampled system CPU, per-process CPU sparklines, busiest processes, memory use, elapsed time, and a real process topology graph.

```text
[1 launchd]
├─ [Google Chrome]
│  ├─ [Chrome Renderer]
│  └─ [Chrome Helper]
└─ [Code]
   └─ [Code Helper]
```

This graph is OS ancestry (`parent PID → child PID`), not a fabricated workflow DAG. Existing system processes have no TaskForge priority, retry, or dependency metadata.

| Platform | Process collector | CPU source |
| --- | --- | --- |
| macOS | `ps` | `top` |
| Linux | `ps` | batch `top` |
| Windows | PowerShell/CIM | `Win32_Processor` |

## Interactive console

```text
taskforge> help
taskforge> demo
taskforge> graph
taskforge> list
taskforge> run
taskforge> events
```

Useful commands: `add`, `add-command`, `list`, `status <id>`, `graph`, `events`, `summary`, `export <file.dot>`, `export-json <file.json>`, and `quit`.

The optional browser view is available with `taskforge dashboard [workflow.json]`; the terminal is the primary interface.

## Build and test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

The test executable covers priority/FIFO behavior, dependency resolution and blocking, cycle detection, retries, permanent failures, failure propagation, metrics, concurrent workers, and graceful shutdown. GitHub Actions builds and tests on macOS, Ubuntu, and Windows.

## Design and scope

Ready-job selection is `O(log n)` with the priority queue. Dependency propagation follows only direct dependents; DFS cycle detection is `O(V + E)`. One scheduler mutex protects state transitions, but arbitrary command work runs outside that lock.

TaskForge is intentionally local-first: no cloud account, Redis, database, Docker, or remote machine control. The strongest next additions are persisted run replay, pause/cancel controls for TaskForge-owned jobs, interactive terminal filtering, and executable-plus-arguments workflow fields that avoid shell strings.

#include "JobScheduler.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

namespace {

using taskforge::Job;
using taskforge::JobId;
using taskforge::JobScheduler;
using taskforge::Priority;
using taskforge::Status;

// Worker threads share stdout during the demo; serialize complete log lines.
std::mutex task_log_mutex;

void log_task(const std::string& message) {
  std::lock_guard<std::mutex> lock(task_log_mutex);
  std::cout << "[Task] " << message << '\n';
  std::cout.flush();
}

Priority parse_priority(const std::string& value) {
  if (value == "high") return Priority::High;
  if (value == "medium") return Priority::Medium;
  if (value == "low") return Priority::Low;
  throw std::invalid_argument("priority must be high, medium, or low");
}

std::vector<JobId> parse_dependencies(const std::string& value) {
  if (value == "-") return {};
  std::vector<JobId> dependencies;
  std::stringstream input(value);
  for (std::string id; std::getline(input, id, ',');) {
    if (id.empty()) throw std::invalid_argument("dependency ids cannot be empty");
    dependencies.push_back(id);
  }
  return dependencies;
}

std::string dependencies_text(const Job& job) {
  if (job.dependencies.empty()) return "-";
  std::ostringstream out;
  for (std::size_t i = 0; i < job.dependencies.size(); ++i) {
    if (i) out << ',';
    out << job.dependencies[i];
  }
  return out.str();
}

// CLI-added jobs model timed work. The engine itself accepts arbitrary functions.
Job make_simulated_job(const std::string& id, Priority priority, int duration_ms,
                       std::vector<JobId> dependencies, unsigned failures,
                       unsigned retries) {
  if (duration_ms < 0) throw std::invalid_argument("duration must be non-negative");
  auto attempts = std::make_shared<unsigned>(0);
  return Job{id, id, priority, std::move(dependencies), retries, 0, Status::Pending,
             [id, duration_ms, failures, attempts] {
               ++*attempts;
               log_task(id + " attempt " + std::to_string(*attempts));
               std::this_thread::sleep_for(std::chrono::milliseconds(duration_ms));
               return *attempts > failures;
             }};
}

// Runs a workflow-authorized command on a scheduler worker. TaskForge does not
// inspect or execute unrelated operating-system processes.
Job make_command_job(const std::string& id, Priority priority,
                     std::vector<JobId> dependencies, unsigned retries,
                     std::string command) {
  if (command.empty()) throw std::invalid_argument("command cannot be empty");
  return Job{id, id, priority, std::move(dependencies), retries, 0, Status::Pending,
             [id, command = std::move(command)] {
               log_task(id + " executing: " + command);
               return std::system(command.c_str()) == 0;
             }};
}

// A small deterministic CPU task proves jobs can execute real application work.
unsigned count_primes(unsigned upper_bound) {
  unsigned count = 0;
  for (unsigned number = 2; number <= upper_bound; ++number) {
    bool prime = true;
    for (unsigned divisor = 2; divisor * divisor <= number; ++divisor) {
      if (number % divisor == 0) { prime = false; break; }
    }
    if (prime) ++count;
  }
  return count;
}

void print_table(const std::vector<Job>& jobs) {
  constexpr int id_width = 15;
  constexpr int state_width = 12;
  constexpr int priority_width = 10;
  constexpr int retry_width = 9;
  std::cout << "\n+-----------------+--------------+------------+-----------+----------------------+\n"
            << "| " << std::left << std::setw(id_width) << "JOB"
            << "| " << std::setw(state_width) << "STATE"
            << "| " << std::setw(priority_width) << "PRIORITY"
            << "| " << std::setw(retry_width) << "RETRIES"
            << "| DEPENDENCIES         |\n"
            << "+-----------------+--------------+------------+-----------+----------------------+\n";
  for (const auto& job : jobs) {
    std::cout << "| " << std::setw(id_width) << job.id.substr(0, id_width)
              << "| " << std::setw(state_width) << taskforge::to_string(job.status)
              << "| " << std::setw(priority_width) << taskforge::to_string(job.priority)
              << "| " << std::setw(retry_width) << (std::to_string(job.retries) + "/" + std::to_string(job.max_retries))
              << "| " << std::setw(21) << dependencies_text(job).substr(0, 21) << "|\n";
  }
  std::cout << "+-----------------+--------------+------------+-----------+----------------------+\n";
}

void print_graph(const std::vector<Job>& jobs) {
  std::cout << "\nDEPENDENCY GRAPH (an arrow means 'must finish before')\n\n";
  for (const auto& job : jobs) {
    std::cout << "  [" << taskforge::to_string(job.status) << "] " << job.id;
    if (job.dependencies.empty()) {
      std::cout << "  (entry job)\n";
    } else {
      std::cout << "  <-- ";
      for (std::size_t i = 0; i < job.dependencies.size(); ++i) {
        if (i) std::cout << ", ";
        std::cout << job.dependencies[i];
      }
      std::cout << '\n';
    }
  }
  std::cout << "\nLifecycle: PENDING -> BLOCKED/READY -> RUNNING -> COMPLETED\n"
            << "                                      -> retry -> READY\n"
            << "                                      -> FAILED -> dependent CANCELLED\n";
}

void print_events(const std::vector<taskforge::SchedulerEvent>& events) {
  std::cout << "\nSCHEDULER AUDIT TRAIL\n"
            << "  #    TIME     JOB              STATE        DECISION\n"
            << "---------------------------------------------------------------\n";
  for (const auto& event : events) {
    std::cout << std::right << std::setw(4) << event.sequence << "  "
              << std::setw(6) << event.elapsed.count() << " ms  "
              << std::left << std::setw(16) << event.job_id.substr(0, 16)
              << std::setw(13) << taskforge::to_string(event.status)
              << event.message << '\n';
  }
}

void export_dot(const std::vector<Job>& jobs, const std::string& path) {
  std::ofstream output(path);
  if (!output) throw std::runtime_error("could not write " + path);
  output << "digraph TaskForge {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n";
  for (const auto& job : jobs) {
    output << "  \"" << job.id << "\" [label=\"" << job.id << "\\n"
           << taskforge::to_string(job.status) << "\"];\n";
    for (const auto& dependency : job.dependencies) {
      output << "  \"" << dependency << "\" -> \"" << job.id << "\";\n";
    }
  }
  output << "}\n";
  std::cout << "Wrote Graphviz dependency graph to " << path << ".\n";
}

std::string json_escape(const std::string& value) {
  std::string escaped;
  for (const char character : value) {
    if (character == '"' || character == '\\') escaped += '\\';
    escaped += character;
  }
  return escaped;
}

void export_json(const JobScheduler& scheduler, const std::string& path) {
  std::ofstream output(path);
  if (!output) throw std::runtime_error("could not write " + path);
  const auto jobs = scheduler.jobs();
  const auto events = scheduler.events();
  const auto metrics = scheduler.metrics();
  output << "{\"jobs\":[";
  for (std::size_t i = 0; i < jobs.size(); ++i) {
    const auto& job = jobs[i];
    if (i) output << ',';
    output << "{\"id\":\"" << json_escape(job.id) << "\",\"state\":\""
           << taskforge::to_string(job.status) << "\",\"priority\":\""
           << taskforge::to_string(job.priority) << "\",\"dependencies\":[";
    for (std::size_t index = 0; index < job.dependencies.size(); ++index) {
      if (index) output << ',';
      output << "\"" << json_escape(job.dependencies[index]) << "\"";
    }
    output << "]}";
  }
  output << "],\"events\":[";
  for (std::size_t i = 0; i < events.size(); ++i) {
    const auto& event = events[i];
    if (i) output << ',';
    output << "{\"sequence\":" << event.sequence << ",\"elapsedMs\":"
           << event.elapsed.count() << ",\"jobId\":\"" << json_escape(event.job_id)
           << "\",\"state\":\"" << taskforge::to_string(event.status)
           << "\",\"message\":\"" << json_escape(event.message) << "\"}";
  }
  output << "],\"metrics\":{\"submitted\":" << metrics.submitted
         << ",\"completed\":" << metrics.completed << ",\"failed\":" << metrics.failed
         << ",\"retries\":" << metrics.retries << ",\"peakRunning\":" << metrics.peak_running << "}}";
}

void print_help() {
  std::cout << R"(Commands:
  demo                    Load a real-work sample pipeline (before run).
  add <id> <priority> <ms> <deps|-> <failures> <retries>
                          Add a timed job; dependencies are comma-separated.
  add-command <id> <priority> <deps|-> <retries> <shell command>
                          Add a real command job that runs on a worker thread.
  list                    Show a dashboard table of all jobs.
  graph                   Show dependency graph and state lifecycle.
  events                  Show the scheduler's timestamped decision audit trail.
  export <file.dot>       Export the dependency graph for Graphviz rendering.
  export-json <file.json> Export real scheduler state/events for tooling.
  status <id>             Inspect one job.
  run                     Start workers, execute jobs, and show final metrics.
  summary                 Show live metrics.
  learn                   Explain what the scheduler is demonstrating.
  help                    Show commands.
  quit                    Stop workers and exit.
)";
}

void print_learning_guide() {
  std::cout << R"(
TaskForge is a miniature operating-system-style scheduler.

1. You submit jobs. Each job has a priority, function, dependencies, and retry policy.
2. The dependency graph keeps jobs BLOCKED until every prerequisite is COMPLETED.
3. READY jobs enter the scheduling queue. High priority wins; ties use FIFO order.
4. A fixed pool of worker threads takes READY jobs concurrently.
5. A false return or exception retries the job when retries remain; otherwise it FAILS.
6. Metrics and the graph make the effect visible.

Try: demo, graph, list, run, graph, summary
Notice that after config, catalog_scan and search_index run independently and may overlap.
)";
}

void print_job(const Job& job) {
  std::cout << "Job: " << job.id << "\nState: " << taskforge::to_string(job.status)
            << "\nPriority: " << taskforge::to_string(job.priority)
            << "\nDependencies: " << dependencies_text(job)
            << "\nRetries: " << job.retries << '/' << job.max_retries
            << "\nLast run time: " << job.run_time.count() << " ms\n";
}

void load_demo(JobScheduler& scheduler) {
  scheduler.add(Job{"config", "Validate configuration", Priority::High, {}, 0, 0,
                    Status::Pending, [] {
                      const std::string config = "workers=3;dataset=2026-Q3";
                      log_task("validated " + config);
                      return config.find("workers") != std::string::npos;
                    }});
  scheduler.add(Job{"catalog_scan", "Calculate catalog checksum", Priority::High,
                    {"config"}, 0, 0, Status::Pending, [] {
                      unsigned checksum = 0;
                      for (unsigned value = 1; value <= 1000000; ++value) checksum = (checksum + value * 17U) % 1000003U;
                      log_task("catalog checksum: " + std::to_string(checksum));
                      return true;
                    }});
  scheduler.add(Job{"search_index", "Build prime index", Priority::Medium,
                    {"config"}, 0, 0, Status::Pending, [] {
                      log_task("indexed " + std::to_string(count_primes(100000)) + " primes");
                      return true;
                    }});
  scheduler.add(Job{"report", "Create report", Priority::Low,
                    {"catalog_scan", "search_index"}, 0, 0, Status::Pending, [] {
                      log_task("assembled report from both completed branches");
                      return true;
                    }});
  auto notification_attempts = std::make_shared<unsigned>(0);
  scheduler.add(Job{"notify", "Send notification", Priority::Medium, {"report"}, 2, 0,
                    Status::Pending, [notification_attempts] {
                      ++*notification_attempts;
                      log_task("notification attempt " + std::to_string(*notification_attempts));
                      return *notification_attempts == 2;
                    }});
  std::cout << "Demo loaded. It contains two parallel real CPU tasks and a retrying notification.\n";
}

}  // namespace

int main() {
  JobScheduler scheduler(3);
  std::cout << "TaskForge Scheduler Console\nType 'learn' to understand it, or 'help' for commands.\n";

  for (std::string line; std::cout << "taskforge> ", std::getline(std::cin, line);) {
    std::istringstream input(line);
    std::string command;
    input >> command;
    try {
      if (command == "help") print_help();
      else if (command == "learn") print_learning_guide();
      else if (command == "demo") load_demo(scheduler);
      else if (command == "list") print_table(scheduler.jobs());
      else if (command == "graph") print_graph(scheduler.jobs());
      else if (command == "events") print_events(scheduler.events());
      else if (command == "export") {
        std::string path;
        if (!(input >> path)) throw std::invalid_argument("usage: export <file.dot>");
        export_dot(scheduler.jobs(), path);
      }
      else if (command == "export-json") {
        std::string path;
        if (!(input >> path)) throw std::invalid_argument("usage: export-json <file.json>");
        export_json(scheduler, path);
        std::cout << "Wrote scheduler data to " << path << ".\n";
      }
      else if (command == "status") {
        std::string id;
        if (!(input >> id)) throw std::invalid_argument("usage: status <id>");
        print_job(scheduler.job(id));
      } else if (command == "add") {
        std::string id, priority, dependency_text;
        int duration_ms;
        unsigned failures, retries;
        if (!(input >> id >> priority >> duration_ms >> dependency_text >> failures >> retries))
          throw std::invalid_argument("usage: add <id> <priority> <ms> <deps|-> <failures> <retries>");
        scheduler.add(make_simulated_job(id, parse_priority(priority), duration_ms,
                                         parse_dependencies(dependency_text), failures, retries));
        std::cout << "Added job '" << id << "'. Use list or graph to inspect it.\n";
      } else if (command == "add-command") {
        std::string id, priority, dependency_text;
        unsigned retries;
        if (!(input >> id >> priority >> dependency_text >> retries))
          throw std::invalid_argument("usage: add-command <id> <priority> <deps|-> <retries> <shell command>");
        std::string shell_command;
        std::getline(input >> std::ws, shell_command);
        scheduler.add(make_command_job(id, parse_priority(priority),
                                       parse_dependencies(dependency_text), retries,
                                       shell_command));
        std::cout << "Added command job '" << id << "'.\n";
      } else if (command == "run") {
        scheduler.start();
        scheduler.wait();
        print_table(scheduler.jobs());
        std::cout << scheduler.summary();
      } else if (command == "summary") std::cout << scheduler.summary();
      else if (command == "quit" || command == "exit") { scheduler.stop(); break; }
      else if (!command.empty()) std::cout << "Unknown command. Type 'help'.\n";
    } catch (const std::exception& error) {
      std::cout << "Error: " << error.what() << '\n';
    }
  }
}

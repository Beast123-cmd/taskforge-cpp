#include "JobScheduler.hpp"

#include <chrono>
#include <iostream>
#include <memory>
#include <sstream>
#include <thread>

namespace {

using taskforge::Job;
using taskforge::JobId;
using taskforge::JobScheduler;
using taskforge::Priority;

Priority parse_priority(const std::string& value) {
  if (value == "high") return Priority::High;
  if (value == "medium") return Priority::Medium;
  if (value == "low") return Priority::Low;
  throw std::invalid_argument("priority must be high, medium, or low");
}

std::vector<JobId> parse_dependencies(const std::string& value) {
  if (value == "-") return {};
  std::vector<JobId> result;
  std::stringstream input(value);
  for (std::string id; std::getline(input, id, ',');) {
    if (id.empty()) throw std::invalid_argument("dependency ids cannot be empty");
    result.push_back(id);
  }
  return result;
}

// The CLI intentionally uses simulated work. The scheduler API accepts any bool-returning function.
Job make_simulated_job(const std::string& id, Priority priority, int duration_ms,
                       std::vector<JobId> dependencies, unsigned failures,
                       unsigned retries) {
  if (duration_ms < 0) throw std::invalid_argument("duration must be non-negative");
  auto attempts = std::make_shared<unsigned>(0);
  return Job{id, id, priority, std::move(dependencies), retries, 0,
             taskforge::Status::Pending,
             [id, duration_ms, failures, attempts] {
               ++*attempts;
               std::cout << "[Worker] Running " << id << " (attempt " << *attempts << ")\n";
               std::this_thread::sleep_for(std::chrono::milliseconds(duration_ms));
               return *attempts > failures;
             }};
}

void print_help() {
  std::cout << R"(Commands:
  help
      Show this command reference.
  add <id> <high|medium|low> <duration_ms> <deps|-> <failures> <retries>
      Register a simulated job. Dependencies are comma-separated IDs or '-'.
      Example: add report low 100 dataset 0 0
  demo
      Load a useful sample workflow, including a controlled retry. Must be used before run.
  list
      Show every submitted job, its status, priority, dependencies, and retries.
  status <id>
      Show details for one job.
  run
      Start workers and wait for all jobs to finish.
  summary
      Print live execution metrics.
  quit
      Stop workers (if needed) and exit.
)";
}

void print_job(const Job& job) {
  std::cout << job.id << " | " << taskforge::to_string(job.status)
            << " | " << taskforge::to_string(job.priority)
            << " | retries " << job.retries << '/' << job.max_retries
            << " | dependencies: ";
  if (job.dependencies.empty()) std::cout << '-';
  for (std::size_t i = 0; i < job.dependencies.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << job.dependencies[i];
  }
  std::cout << '\n';
}

void load_demo(JobScheduler& scheduler) {
  scheduler.add(make_simulated_job("config", Priority::High, 40, {}, 0, 0));
  scheduler.add(make_simulated_job("database", Priority::High, 80, {"config"}, 0, 0));
  scheduler.add(make_simulated_job("dataset", Priority::Medium, 120, {"database"}, 0, 0));
  scheduler.add(make_simulated_job("report", Priority::Low, 50, {"dataset"}, 0, 0));
  scheduler.add(make_simulated_job("notify", Priority::Medium, 30, {"report"}, 1, 2));
  std::cout << "Sample workflow loaded. Use 'list' to inspect it, then 'run'.\n";
}

}  // namespace

int main() {
  JobScheduler scheduler(3);
  std::cout << "TaskForge interactive scheduler. Type 'help' for commands.\n";

  for (std::string line; std::cout << "taskforge> ", std::getline(std::cin, line);) {
    std::istringstream input(line);
    std::string command;
    input >> command;
    try {
      if (command == "help") {
        print_help();
      } else if (command == "add") {
        std::string id, priority, dependency_text;
        int duration_ms;
        unsigned failures, retries;
        if (!(input >> id >> priority >> duration_ms >> dependency_text >> failures >> retries)) {
          throw std::invalid_argument("usage: add <id> <priority> <duration_ms> <deps|-> <failures> <retries>");
        }
        scheduler.add(make_simulated_job(id, parse_priority(priority), duration_ms,
                                         parse_dependencies(dependency_text), failures, retries));
        std::cout << "Added job '" << id << "'.\n";
      } else if (command == "demo") {
        load_demo(scheduler);
      } else if (command == "list") {
        for (const auto& job : scheduler.jobs()) print_job(job);
      } else if (command == "status") {
        std::string id;
        if (!(input >> id)) throw std::invalid_argument("usage: status <id>");
        print_job(scheduler.job(id));
      } else if (command == "run") {
        scheduler.start();
        scheduler.wait();
        std::cout << scheduler.summary();
      } else if (command == "summary") {
        std::cout << scheduler.summary();
      } else if (command == "quit" || command == "exit") {
        scheduler.stop();
        break;
      } else if (!command.empty()) {
        std::cout << "Unknown command. Type 'help'.\n";
      }
    } catch (const std::exception& error) {
      std::cout << "Error: " << error.what() << '\n';
    }
  }
}

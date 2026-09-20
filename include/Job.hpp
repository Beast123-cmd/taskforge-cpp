#pragma once
#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace taskforge {

// A priority is evaluated only after all job dependencies are satisfied.
enum class Priority { Low, Medium, High };

// The scheduler owns all transitions between these states.
enum class Status { Pending, Blocked, Ready, Running, Completed, Failed, Cancelled };
using JobId = std::string;
using JobFunction = std::function<bool()>;
struct Job {
  JobId id;
  std::string name;
  Priority priority{Priority::Medium};
  std::vector<JobId> dependencies;
  unsigned max_retries{0};
  unsigned retries{0};
  Status status{Status::Pending};
  // Return true to complete the job; false requests a retry or final failure.
  JobFunction task;
  std::chrono::steady_clock::time_point submitted_at{};
  std::chrono::steady_clock::time_point started_at{};
  std::chrono::milliseconds wait_time{0};
  std::chrono::milliseconds run_time{0};
};
const char* to_string(Status status);
const char* to_string(Priority priority);
}

#pragma once
#include <chrono>
#include <cstddef>
#include <mutex>

namespace taskforge {
struct Metrics { std::size_t submitted{}, completed{}, failed{}, retries{}, running{}, peak_running{}; std::chrono::milliseconds total_wait{0}, total_run{0}; };
class MetricsCollector {
  mutable std::mutex mutex_; Metrics data_;
 public:
  void submitted(); void started(std::chrono::milliseconds wait); void finished(bool ok, std::chrono::milliseconds run); void retried();
  Metrics snapshot() const;
};
}

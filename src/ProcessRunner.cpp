#include "ProcessRunner.hpp"

#include <cerrno>
#include <vector>

#ifdef _WIN32
#include <process.h>
#include <windows.h>
#else
#include <spawn.h>
#include <sys/wait.h>

extern char** environ;
#endif

namespace taskforge {

#ifdef _WIN32
namespace {
std::wstring utf8_to_wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       value.c_str(), -1, nullptr, 0);
  if (size == 0) return {};
  std::wstring wide(static_cast<std::size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), -1,
                          wide.data(), size) == 0) return {};
  wide.pop_back();
  return wide;
}
}  // namespace
#endif

int run_executable(const std::string& executable,
                   const std::vector<std::string>& arguments) {
  if (executable.empty()) return -1;

#ifdef _WIN32
  const std::wstring program = utf8_to_wide(executable);
  if (program.empty()) return -1;
  std::vector<std::wstring> values{program};
  for (const auto& argument : arguments) values.push_back(utf8_to_wide(argument));
  std::vector<const wchar_t*> argv;
  for (const auto& value : values) argv.push_back(value.c_str());
  argv.push_back(nullptr);
  return static_cast<int>(_wspawnvp(_P_WAIT, program.c_str(), argv.data()));
#else
  std::vector<std::string> values{executable};
  values.insert(values.end(), arguments.begin(), arguments.end());
  std::vector<char*> argv;
  for (auto& value : values) argv.push_back(value.data());
  argv.push_back(nullptr);
  pid_t child{};
  if (posix_spawnp(&child, executable.c_str(), nullptr, nullptr,
                   argv.data(), environ) != 0) return -1;
  int status{};
  while (waitpid(child, &status, 0) == -1) {
    if (errno != EINTR) return -1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return -1;
#endif
}

}  // namespace taskforge

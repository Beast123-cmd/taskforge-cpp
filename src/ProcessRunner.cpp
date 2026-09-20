#include "ProcessRunner.hpp"

#include <cerrno>
#include <vector>

#ifdef _WIN32
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

// Windows receives one command-line string. Quote using the argument rules
// understood by the Microsoft C runtime (also used by Node.js on Windows).
std::wstring quote_argument(const std::wstring& value) {
  std::wstring quoted = L"\"";
  std::size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
    } else if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(character);
      backslashes = 0;
    }
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}
}  // namespace
#endif

int run_executable(const std::string& executable,
                   const std::vector<std::string>& arguments) {
  if (executable.empty()) return -1;

#ifdef _WIN32
  const std::wstring program = utf8_to_wide(executable);
  if (program.empty()) return -1;
  std::wstring command_line = quote_argument(program);
  for (const auto& argument : arguments) {
    const std::wstring wide = utf8_to_wide(argument);
    if (!argument.empty() && wide.empty()) return -1;
    command_line += L' ';
    command_line += quote_argument(wide);
  }
  if (command_line.size() >= 32767) return -1;

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command_line.data(), nullptr, nullptr, TRUE, 0,
                      nullptr, nullptr, &startup, &process)) return -1;
  CloseHandle(process.hThread);
  const DWORD wait_result = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_status = 0;
  const bool succeeded = wait_result == WAIT_OBJECT_0 &&
                         GetExitCodeProcess(process.hProcess, &exit_status);
  CloseHandle(process.hProcess);
  return succeeded ? static_cast<int>(exit_status) : -1;
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

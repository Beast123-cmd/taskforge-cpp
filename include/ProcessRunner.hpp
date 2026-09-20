#pragma once

#include <string>
#include <vector>

namespace taskforge {

// Launch an executable with literal arguments and wait for its exit status.
// No shell parses the arguments. Returns -1 when the process cannot start.
int run_executable(const std::string& executable,
                   const std::vector<std::string>& arguments);

}  // namespace taskforge

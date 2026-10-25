set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86)
set(CMAKE_C_COMPILER /opt/td/cl-wine.sh)
set(CMAKE_CXX_COMPILER "${CMAKE_C_COMPILER}")
# Cross-compiling: configure checks must not try to run a Windows executable.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_AR /opt/td/lib-wine.sh)
set(CMAKE_TRY_COMPILE_CONFIGURATION Release)

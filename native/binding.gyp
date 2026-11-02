{
  "targets": [
    {
      "target_name": "ppsspp_core",
      "sources": ["ppsspp_core.cc", "jpge.cpp"],
      "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN", "UNICODE", "_UNICODE"],
      "libraries": ["opengl32.lib", "user32.lib", "gdi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}

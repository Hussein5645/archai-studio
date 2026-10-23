{
  "targets": [{
    "target_name": "archai_unreal_host",
    "sources": ["host.cpp"],
    "libraries": ["user32.lib"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
    "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++20", "/EHsc"], "ExceptionHandling": 1 } }
  }]
}

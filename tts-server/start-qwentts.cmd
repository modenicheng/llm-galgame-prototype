@echo off
rem Launch the qwentts.cpp engine and register this project's voices.
rem Deployment root defaults to D:\tools\qwentts.cpp; override with QWENTTS_HOME.
rem Generic deployment guide: docs/local-tts.md (repo).
if "%QWENTTS_HOME%"=="" set QWENTTS_HOME=D:\tools\qwentts.cpp
if not exist "%QWENTTS_HOME%\build\tts-server.exe" (
  echo qwentts.cpp engine not found at %QWENTTS_HOME% -- see docs/local-tts.md
  exit /b 1
)
start "qwentts-server" /D "%QWENTTS_HOME%" build\tts-server.exe ^
    --model models/qwen-talker-1.7b-base-Q8_0.gguf ^
    --codec models/qwen-tokenizer-12hz-Q8_0.gguf ^
    --alias local-qwen3-tts --host 0.0.0.0 --port 9766 --lang auto --max-batch 4
python "%~dp0tools\register_qwentts_voices.py" --voices-dir "%QWENTTS_HOME%\voices"
echo qwentts.cpp engine ready on 0.0.0.0:9766 (LAN accessible)

#!/usr/bin/env bash
# review-package BASE HEAD — write diff to a uniquely named file, print path
set -euo pipefail
BASE="$1"; HEAD="$2"
OUT=".superpowers/sdd/review-$(date +%s).txt"
{
  echo "=== COMMITS $BASE..$HEAD ==="
  git log --oneline "$BASE..$HEAD"
  echo
  echo "=== STAT ==="
  git diff --stat "$BASE" "$HEAD"
  echo
  echo "=== DIFF ==="
  git diff -U10 "$BASE" "$HEAD"
} > "$OUT"
echo "$OUT"

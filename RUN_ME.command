#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 أو أحدث مطلوب. ثبّته ثم أعد التشغيل."
  read -r
  exit 1
fi
MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$MAJOR" -lt 22 ]; then
  echo "الإصدار الحالي $(node -v). يلزم Node.js 22 أو أحدث."
  read -r
  exit 1
fi
[ -f .env ] || cp .env.example .env
[ -d node_modules ] || npm install
npm run dev

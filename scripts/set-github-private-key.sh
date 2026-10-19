#!/usr/bin/env bash
# GitHub App の秘密鍵 (.pem) を PKCS#8 に変換し、改行を \n にエスケープして
# .dev.vars の GITHUB_PRIVATE_KEY に書き込む。
#
# 使い方: scripts/set-github-private-key.sh <ダウンロードした.pem> [.dev.vars のパス]
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "使い方: $0 <private-key.pem> [.dev.vars]" >&2
  exit 1
fi

pem=$1
dev_vars=${2:-.dev.vars}

if [[ ! -f $pem ]]; then
  echo "鍵ファイルが見つからないよ: $pem" >&2
  exit 1
fi

# openssl pkey は入力が PKCS#1 でも PKCS#8 でも PKCS#8 で出力する。
# Windows で作られたファイルの CR が混ざると dotenv の値に残るので落とす。
key=$(openssl pkey -in "$pem" | tr -d '\r' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }')

if [[ $key != "-----BEGIN PRIVATE KEY-----"* ]]; then
  echo "PKCS#8 への変換に失敗したよ" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

if [[ -f $dev_vars ]]; then
  grep -v '^[[:space:]]*GITHUB_PRIVATE_KEY[[:space:]]*=' "$dev_vars" | tr -d '\r' >"$tmp" || true
  # 最終行に改行がないと追記した行が前の行とくっつく
  if [[ -s $tmp && $(tail -c 1 "$tmp") != "" ]]; then
    echo >>"$tmp"
  fi
fi
printf 'GITHUB_PRIVATE_KEY="%s"\n' "$key" >>"$tmp"

cat "$tmp" >"$dev_vars"
echo "✅ $dev_vars に GITHUB_PRIVATE_KEY を書き込んだよ"

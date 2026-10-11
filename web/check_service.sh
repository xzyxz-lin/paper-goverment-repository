#!/usr/bin/env bash
# 检查私人文献库服务是否真的在线。
#
# 为什么需要这个脚本：
#   后台任务（Bash run_in_background / nohup ... &）报 "failed" 时，
#   被系统回收的往往只是任务外壳，python 进程脱离父进程后仍在监听端口。
#   所以「任务失败」≠「服务挂了」，先探测端口再决定要不要重启，
#   否则可能把正在正常服务的实例给杀掉。
#
# 用法：
#   bash web/check_service.sh          # 只检查
#   bash web/check_service.sh --verbose  # 附带进程与静态资源探测

set -uo pipefail
PORT="${PORT:-8040}"
BASE="http://127.0.0.1:${PORT}"

# Git Bash 里 http_proxy 会拦本地请求，必须 --noproxy
curl_json() { curl -s --noproxy "*" -m 5 "$@"; }

echo "== 端口 ${PORT} =="
PID="$(netstat -ano | grep "LISTENING" | grep ":${PORT}" | awk '{print $NF}' | head -1)"
if [ -z "$PID" ]; then
  echo "没有进程在监听 ${PORT}"
  echo "结论：服务未运行。启动方式："
  echo "  .venv\\Scripts\\python.exe web\\library.py --host 0.0.0.0 --port ${PORT}"
  echo "  （或双击桌面快捷方式 / web\\start_web.cmd）"
  exit 1
fi
echo "监听中，PID=${PID}"

echo
echo "== 健康检查 =="
HEALTH="$(curl_json "${BASE}/api/health")"
if [ -z "$HEALTH" ]; then
  echo "端口被占但 /api/health 无响应（可能是别的程序占用，或进程卡死）"
  exit 2
fi
echo "$HEALTH"

if [ "${1:-}" = "--verbose" ]; then
  echo
  echo "== 静态资源 =="
  for f in library.js library.css; do
    printf "  %-12s " "$f"
    curl_json -o /dev/null -w "%{http_code}\n" "${BASE}/${f}"
  done
  printf "  %-12s " "root"
  curl_json -o /dev/null -w "%{http_code}\n" "${BASE}/"

  echo
  echo "== 落盘状态（WAL 越小越安全，0 表示已全部合并进主库）=="
  DB="data/library.db"
  if [ -f "${DB}-wal" ]; then
    echo "  ${DB}-wal: $(stat -c%s "${DB}-wal") bytes"
  else
    echo "  没有 WAL 文件（非 WAL 模式或已合并）"
  fi
fi

echo
echo "结论：服务正常，无需重启。"

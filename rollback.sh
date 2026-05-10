#!/bin/bash
# CloudAI SaaS 回滚脚本
# 用法: ./rollback.sh [backend] [version-id]
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${YELLOW}[ROLLBACK]${NC} $1"; }

TARGET=${1:-backend}
VERSION_ID=${2:-}

if [ -z "$VERSION_ID" ]; then
    echo "Available versions:"
    npx wrangler versions list --name cloudai-api 2>/dev/null | head -20
    echo ""
    echo "Usage: $0 backend <version-id>"
    exit 0
fi

log "Rolling back $TARGET to version $VERSION_ID..."
npx wrangler rollback "$VERSION_ID" --name cloudai-api
log "Rollback complete ✅"

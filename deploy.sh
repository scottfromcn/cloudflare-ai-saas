#!/bin/bash
# CloudAI SaaS 部署脚本
# 用法: ./deploy.sh [frontend|backend|all]

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

TARGET=${1:-all}

deploy_frontend() {
    log "Deploying frontend to Cloudflare Pages..."
    cd "$(dirname "$0")/frontend"
    
    # 如果有构建步骤（如 Astro/Next.js），先构建
    # npm run build
    
    npx wrangler pages deploy . --project-name=cloudai-frontend
    log "Frontend deployed ✅"
    log "URL: https://cloudai-frontend.pages.dev"
}

deploy_backend() {
    log "Deploying backend Worker to Cloudflare..."
    cd "$(dirname "$0")/backend"
    
    # 类型检查（可选）
    # npx tsc --noEmit
    
    npx wrangler deploy
    log "Backend deployed ✅"
    log "URL: https://cloudai-api.xjqwww.workers.dev"
}

case "$TARGET" in
    frontend) deploy_frontend ;;
    backend)  deploy_backend ;;
    all)
        deploy_backend
        deploy_frontend
        log "All deployed! 🚀"
        ;;
    *)
        echo "Usage: $0 [frontend|backend|all]"
        exit 1
        ;;
esac

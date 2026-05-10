# CloudAI — 边缘 AI 助手平台

基于 Cloudflare 全家桶构建的 AI SaaS 应用实战项目。

## 项目结构

```
cloudflare-ai-saas/
├── frontend/              # Cloudflare Pages 前端
│   └── index.html         # AI SaaS Landing Page
├── backend/               # Cloudflare Worker API
│   ├── src/index.ts       # API 网关 + AI 推理 + 数据层
│   ├── schema.sql         # D1 数据库 Schema
│   ├── wrangler.toml      # Worker 配置（绑定 D1/KV/AI/Vectorize）
│   └── package.json
├── .github/workflows/     # GitHub Actions CI/CD
│   └── deploy.yml
├── deploy.sh              # 一键部署脚本
└── rollback.sh            # 回滚脚本
```

## 已部署资源

| 资源 | 名称 | URL |
|------|------|-----|
| Pages | cloudai-frontend | https://cloudai-frontend.pages.dev |
| Worker | cloudai-api | https://cloudai-api.xjqwww.workers.dev |
| D1 | cloudai-db | 5 tables initialized |
| KV | CACHE | Namespace created |
| Vectorize | cloudai-embeddings | 768d / cosine |

## API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| /api/health | GET | 健康检查（D1+KV 连通性） |
| /api/chat | POST | AI 聊天（Workers AI） |
| /api/models | GET | 可用模型列表 |
| /api/embed | POST | 文本向量化 |
| /api/vector/upsert | POST | 向量写入 |
| /api/vector/search | POST | 向量搜索 |
| /api/usage | GET | 用量统计 |
| /api/cache/set | POST | KV 写入 |
| /api/cache/get | GET | KV 读取 |

## 部署方式

### 方式 1: 直接部署（MVP / 开发）
```bash
./deploy.sh          # 全部部署
./deploy.sh frontend # 只部署前端
./deploy.sh backend  # 只部署后端
```

### 方式 2: GitHub CI/CD（生产推荐）
```bash
git push origin main
# GitHub Actions 自动部署
```

### 方式 3: Agent + MCP（快速验证）
通过 Hermes Agent + Cloudflare MCP Server 直接操作，无需 git。

## 回滚
```bash
./rollback.sh backend <version-id>
```

## 成本

| 阶段 | 预估月费 |
|------|---------|
| MVP（<100 用户） | $0-5 |
| 增长期（1K-10K 用户） | $50-200 |
| 规模化（10K-100K 用户） | $500-2000 |

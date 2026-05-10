// CloudAI API Worker — Phase 4: Full Stack with AI + DB + Cache + Vector
interface Env {
  AI: any;
  DB: D1Database;
  CACHE: KVNamespace;
  VECTORIZE: VectorizeIndex;
  ENVIRONMENT: string;
  APP_NAME: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const startTime = Date.now();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== Health Check =====
    if (url.pathname === '/api/health') {
      // 同时检查 D1 和 KV 连通性
      const dbCheck = await env.DB.prepare('SELECT 1 as ok').first();
      const cacheCheck = await env.CACHE.get('_ping');
      return jsonResponse({
        status: 'ok',
        app: env.APP_NAME,
        env: env.ENVIRONMENT,
        d1: dbCheck?.ok === 1 ? 'connected' : 'error',
        kv: 'connected',
        vectorize: 'connected',
        timestamp: new Date().toISOString(),
        phase: 'Phase 4 — Full Stack AI SaaS',
      });
    }

    // ===== AI Chat with DB Logging =====
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const { message, model, conversationId } = await request.json() as {
          message: string; model?: string; conversationId?: string;
        };

        if (!message) return jsonResponse({ error: 'message is required' }, 400);

        const aiModel = model || '@cf/meta/llama-3.1-8b-instruct-fast';

        // 调用 Workers AI
        const aiStart = Date.now();
        const response = await env.AI.run(aiModel, {
          messages: [
            { role: 'system', content: '你是 CloudAI 助手，一个友好、专业的 AI 助手。用中文回答问题，回答简洁有力。' },
            { role: 'user', content: message },
          ],
        });
        const aiLatency = Date.now() - aiStart;

        // 记录到 D1
        const logId = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO usage_logs (id, user_id, model, input_tokens, output_tokens, request_type, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          logId, 'demo-user-001', aiModel,
          50, 100, 'chat', aiLatency, Math.floor(Date.now() / 1000)
        ).run();

        return jsonResponse({
          response: response.response || 'No response',
          model: aiModel,
          latency_ms: aiLatency,
          conversation_id: conversationId,
          phase: 'Phase 4 — Workers AI + D1 Logging',
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message || 'AI inference failed' }, 500);
      }
    }

    // ===== Embedding + Vector Search (RAG) =====
    if (url.pathname === '/api/embed' && request.method === 'POST') {
      try {
        const { text } = await request.json() as { text: string };
        if (!text) return jsonResponse({ error: 'text is required' }, 400);

        // 生成向量嵌入
        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [text],
        });

        return jsonResponse({
          dimensions: embeddings.data?.[0]?.length || 0,
          preview: embeddings.data?.[0]?.slice(0, 5),
          phase: 'Phase 4 — Embedding',
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message || 'Embedding failed' }, 500);
      }
    }

    // ===== Vector Upsert =====
    if (url.pathname === '/api/vector/upsert' && request.method === 'POST') {
      try {
        const { id, text, metadata } = await request.json() as {
          id: string; text: string; metadata?: Record<string, string>;
        };

        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [text],
        });

        await env.VECTORIZE.upsert([{
          id: id,
          values: embeddings.data[0],
          metadata: metadata || {},
        }]);

        return jsonResponse({
          status: 'upserted',
          id,
          phase: 'Phase 4 — Vector Upsert',
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message || 'Vector upsert failed' }, 500);
      }
    }

    // ===== Vector Search =====
    if (url.pathname === '/api/vector/search' && request.method === 'POST') {
      try {
        const { query, topK } = await request.json() as { query: string; topK?: number };

        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [query],
        });

        const results = await env.VECTORIZE.query(embeddings.data[0], {
          topK: topK || 5,
          returnMetadata: 'all',
        });

        return jsonResponse({
          matches: results.matches?.length || 0,
          results: results.matches,
          phase: 'Phase 4 — Vector Search',
        });
      } catch (e: any) {
        return jsonResponse({ error: e.message || 'Vector search failed' }, 500);
      }
    }

    // ===== Usage Stats (from D1) =====
    if (url.pathname === '/api/usage') {
      const stats = await env.DB.prepare(
        'SELECT model, COUNT(*) as requests, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, AVG(latency_ms) as avg_latency FROM usage_logs GROUP BY model'
      ).all();

      return jsonResponse({
        usage: stats.results,
        phase: 'Phase 4 — Usage Analytics',
      });
    }

    // ===== KV Demo =====
    if (url.pathname === '/api/cache/set' && request.method === 'POST') {
      const { key, value, ttl } = await request.json() as { key: string; value: string; ttl?: number };
      await env.CACHE.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
      return jsonResponse({ status: 'cached', key });
    }

    if (url.pathname === '/api/cache/get') {
      const key = url.searchParams.get('key');
      if (!key) return jsonResponse({ error: 'key is required' }, 400);
      const value = await env.CACHE.get(key);
      return jsonResponse({ key, value: value || '(not found)' });
    }

    // ===== Models =====
    if (url.pathname === '/api/models') {
      return jsonResponse({
        models: [
          { id: '@cf/meta/llama-3.1-8b-instruct-fast', name: 'Llama 3.1 8B (Fast)', type: 'chat' },
          { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', type: 'chat' },
          { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B', type: 'chat' },
          { id: '@cf/baai/bge-base-en-v1.5', name: 'BGE Embedding', type: 'embedding', dimensions: 768 },
        ],
        phase: 'Phase 4 — Model Registry',
      });
    }

    return jsonResponse({ error: 'Not Found', path: url.pathname }, 404);
  },
};

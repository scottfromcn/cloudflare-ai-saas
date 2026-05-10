// CloudAI API Worker — Phase 5: Auth + Streaming + Payments
// JWT auth, SSE streaming, Stripe payments

interface Env {
  AI: any;
  DB: D1Database;
  CACHE: KVNamespace;
  VECTORIZE: VectorizeIndex;
  ENVIRONMENT: string;
  APP_NAME: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

// ===== CORS =====
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ===== JWT (HMAC-SHA256, no external deps) =====
function base64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function signJWT(payload: Record<string, any>, secret: string, expSeconds = 86400): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + expSeconds }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  const sigB64 = base64url(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${body}.${sigB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(base64urlDecode(sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
  if (!valid) return null;
  const payload = JSON.parse(base64urlDecode(body));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ===== Password Hash (SHA-256 with salt) =====
async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const s = salt || crypto.randomUUID().slice(0, 16);
  const data = new TextEncoder().encode(s + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt: s };
}

async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  return hash === storedHash;
}

// ===== Auth Middleware =====
async function requireAuth(request: Request, env: Env): Promise<{ userId: string; email: string } | Response> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return json({ error: 'Missing authorization header' }, 401);
  const payload = await verifyJWT(auth.slice(7), env.JWT_SECRET);
  if (!payload) return json({ error: 'Invalid or expired token' }, 401);
  return { userId: payload.sub, email: payload.email };
}

// ===== Plan Limits =====
const PLAN_LIMITS: Record<string, { rpm: number; models: string[] }> = {
  free: { rpm: 10, models: ['@cf/meta/llama-3.1-8b-instruct-fast'] },
  pro: { rpm: 60, models: ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'] },
  enterprise: { rpm: 999, models: ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'] },
};

async function checkRateLimit(userId: string, env: Env, plan: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const count = parseInt(await env.CACHE.get(key) || '0');
  if (count >= (PLAN_LIMITS[plan]?.rpm || 10)) return false;
  await env.CACHE.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ===== Stripe Helpers =====
async function createStripeSession(priceId: string, customerId: string, successUrl: string, cancelUrl: string, apiKey: string): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      mode: 'subscription',
      'payment_method_types[0]': 'card',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: successUrl,
      cancel_url: cancelUrl,
      'metadata[user_id]': customerId,
    }).toString(),
  });
  return res.json();
}

async function verifyStripeSignature(payload: string, sig: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(sig, c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
  return valid;
}

// ===== Router =====
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== Health =====
    if (url.pathname === '/api/health') {
      const dbCheck = await env.DB.prepare('SELECT 1 as ok').first();
      return json({ status: 'ok', app: env.APP_NAME, env: env.ENVIRONMENT, d1: dbCheck?.ok === 1 ? 'connected' : 'error', phase: 'Phase 5 — Auth + Streaming + Payments' });
    }

    // ========== AUTH ROUTES (public) ==========

    // POST /api/auth/register
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      try {
        const { email, password, name } = await request.json() as { email: string; password: string; name?: string };
        if (!email || !password) return json({ error: 'email and password required' }, 400);
        if (password.length < 6) return json({ error: 'password must be >= 6 characters' }, 400);

        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return json({ error: 'email already registered' }, 409);

        const userId = crypto.randomUUID();
        const { hash, salt } = await hashPassword(password);
        // Store hash as "salt:hash"
        await env.DB.prepare('INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, email, `${salt}:${hash}`, name || email.split('@')[0], 'free').run();

        const token = await signJWT({ sub: userId, email, plan: 'free' }, env.JWT_SECRET);
        return json({ token, user: { id: userId, email, name: name || email.split('@')[0], plan: 'free' } }, 201);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // POST /api/auth/login
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json() as { email: string; password: string };
        if (!email || !password) return json({ error: 'email and password required' }, 400);

        const user = await env.DB.prepare('SELECT id, email, password_hash, name, plan FROM users WHERE email = ?').bind(email).first() as any;
        if (!user) return json({ error: 'invalid credentials' }, 401);

        const [salt, storedHash] = user.password_hash.split(':');
        const valid = await verifyPassword(password, storedHash, salt);
        if (!valid) return json({ error: 'invalid credentials' }, 401);

        const token = await signJWT({ sub: user.id, email: user.email, plan: user.plan }, env.JWT_SECRET);
        return json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/auth/me
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      const user = await env.DB.prepare('SELECT id, email, name, plan, created_at FROM users WHERE id = ?').bind(auth.userId).first();
      return json({ user });
    }

    // ========== PROTECTED ROUTES ==========

    // POST /api/chat (non-streaming)
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      try {
        const { message, model, conversationId } = await request.json() as { message: string; model?: string; conversationId?: string };
        if (!message) return json({ error: 'message is required' }, 400);

        const aiModel = model || '@cf/meta/llama-3.1-8b-instruct-fast';
        const aiStart = Date.now();
        const response = await env.AI.run(aiModel, {
          messages: [
            { role: 'system', content: '你是 CloudAI 助手，一个友好、专业的 AI 助手。用中文回答问题，回答简洁有力。' },
            { role: 'user', content: message },
          ],
        });
        const latency = Date.now() - aiStart;

        await env.DB.prepare(
          'INSERT INTO usage_logs (id, user_id, model, input_tokens, output_tokens, request_type, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), auth.userId, aiModel, 50, 100, 'chat', latency, Math.floor(Date.now() / 1000)).run();

        return json({ response: response.response || 'No response', model: aiModel, latency_ms: latency, conversation_id: conversationId });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // POST /api/chat/stream (SSE streaming)
    if (url.pathname === '/api/chat/stream' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      try {
        const { message, model } = await request.json() as { message: string; model?: string };
        if (!message) return json({ error: 'message is required' }, 400);

        const aiModel = model || '@cf/meta/llama-3.1-8b-instruct-fast';

        // Workers AI streaming — returns a ReadableStream directly
        const aiStream = await env.AI.run(aiModel, {
          messages: [
            { role: 'system', content: '你是 CloudAI 助手，一个友好、专业的 AI 助手。用中文回答问题，回答简洁有力。' },
            { role: 'user', content: message },
          ],
          stream: true,
        });

        // aiStream is a ReadableStream — get reader
        const rawReader = (aiStream as ReadableStream).getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const cleanStream = new ReadableStream({
          async start(controller) {
            try {
              while (true) {
                const { done, value } = await rawReader.read();
                if (done) {
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                  break;
                }
                // value is Uint8Array from the stream
                const text = decoder.decode(value as Uint8Array, { stream: true });
                // text contains raw SSE lines from Workers AI
                const lines = text.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    try {
                      const chunk = JSON.parse(raw);
                      const content = chunk.response || chunk.choices?.[0]?.delta?.content || '';
                      if (content) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
                      }
                    } catch {}
                  }
                }
              }
            } catch (err) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'stream error' })}\n\n`));
              controller.close();
            }
          },
        });

        return new Response(cleanStream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders,
          },
        });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ========== PAYMENT ROUTES ==========

    // POST /api/payments/checkout — create Stripe checkout session
    if (url.pathname === '/api/payments/checkout' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      try {
        const { priceId } = await request.json() as { priceId?: string };
        // Default pro plan price (user should replace with real Stripe Price ID)
        const price = priceId || 'price_pro_monthly';

        const session = await createStripeSession(
          price,
          auth.userId,
          'https://cloudai-frontend.pages.dev/success',
          'https://cloudai-frontend.pages.dev/pricing',
          env.STRIPE_SECRET_KEY,
        );

        // Log subscription
        if (session.id) {
          await env.DB.prepare(
            'INSERT INTO subscriptions (id, user_id, stripe_session_id, plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), auth.userId, session.id, 'pro', 'pending', Math.floor(Date.now() / 1000)).run();
        }

        return json({ url: session.url, session_id: session.id });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // POST /api/payments/webhook — Stripe webhook handler
    if (url.pathname === '/api/payments/webhook' && request.method === 'POST') {
      try {
        const body = await request.text();
        const sig = request.headers.get('stripe-signature') || '';

        // Parse webhook event
        const event = JSON.parse(body);

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          if (userId) {
            await env.DB.prepare('UPDATE users SET plan = ?, stripe_customer_id = ?, updated_at = ? WHERE id = ?')
              .bind('pro', session.customer, Math.floor(Date.now() / 1000), userId).run();
            await env.DB.prepare('UPDATE subscriptions SET status = ?, stripe_customer_id = ? WHERE stripe_session_id = ?')
              .bind('active', session.customer, session.id).run();
          }
        }

        if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object;
          await env.DB.prepare('UPDATE users SET plan = ?, updated_at = ? WHERE stripe_customer_id = ?')
            .bind('free', Math.floor(Date.now() / 1000), sub.customer).run();
        }

        return json({ received: true });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/subscription
    if (url.pathname === '/api/subscription' && request.method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      const user = await env.DB.prepare('SELECT plan, stripe_customer_id FROM users WHERE id = ?').bind(auth.userId).first() as any;
      const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
        .bind(auth.userId, 'active').first();

      return json({ plan: user?.plan || 'free', subscription: sub, limits: PLAN_LIMITS[user?.plan || 'free'] });
    }

    // ========== EXISTING ROUTES ==========

    // POST /api/embed
    if (url.pathname === '/api/embed' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      try {
        const { text } = await request.json() as { text: string };
        if (!text) return json({ error: 'text is required' }, 400);
        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
        return json({ dimensions: embeddings.data?.[0]?.length || 0, preview: embeddings.data?.[0]?.slice(0, 5) });
      } catch (e: any) { return json({ error: e.message }, 500); }
    }

    // POST /api/vector/upsert
    if (url.pathname === '/api/vector/upsert' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      try {
        const { id, text, metadata } = await request.json() as { id: string; text: string; metadata?: Record<string, string> };
        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
        await env.VECTORIZE.upsert([{ id, values: embeddings.data[0], metadata: metadata || {} }]);
        return json({ status: 'upserted', id });
      } catch (e: any) { return json({ error: e.message }, 500); }
    }

    // POST /api/vector/search
    if (url.pathname === '/api/vector/search' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      try {
        const { query, topK } = await request.json() as { query: string; topK?: number };
        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
        const results = await env.VECTORIZE.query(embeddings.data[0], { topK: topK || 5, returnMetadata: 'all' });
        return json({ matches: results.matches?.length || 0, results: results.matches });
      } catch (e: any) { return json({ error: e.message }, 500); }
    }

    // GET /api/usage
    if (url.pathname === '/api/usage' && request.method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      const stats = await env.DB.prepare(
        'SELECT model, COUNT(*) as requests, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, AVG(latency_ms) as avg_latency FROM usage_logs WHERE user_id = ? GROUP BY model'
      ).bind(auth.userId).all();
      return json({ usage: stats.results });
    }

    // Cache routes
    if (url.pathname === '/api/cache/set' && request.method === 'POST') {
      const { key, value, ttl } = await request.json() as { key: string; value: string; ttl?: number };
      await env.CACHE.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
      return json({ status: 'cached', key });
    }
    if (url.pathname === '/api/cache/get') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'key is required' }, 400);
      return json({ key, value: await env.CACHE.get(key) || '(not found)' });
    }

    // Models
    if (url.pathname === '/api/models') {
      return json({
        models: [
          { id: '@cf/meta/llama-3.1-8b-instruct-fast', name: 'Llama 3.1 8B (Fast)', type: 'chat', plans: ['free', 'pro', 'enterprise'] },
          { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', type: 'chat', plans: ['pro', 'enterprise'] },
          { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B', type: 'chat', plans: ['pro', 'enterprise'] },
          { id: '@cf/baai/bge-base-en-v1.5', name: 'BGE Embedding', type: 'embedding', dimensions: 768 },
        ],
      });
    }

    return json({ error: 'Not Found', path: url.pathname }, 404);
  },
};

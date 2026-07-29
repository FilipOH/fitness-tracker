// Cloudflare Worker - Fitness Tracker API
// This replaces lambda_function.py with JavaScript at the edge!

import { authenticator } from 'otplib'; // For TOTP MFA
import * as bcrypt from 'bcryptjs'; // For password hashing

export default {
  async fetch(request, env, ctx) {
    // env.DB = D1 database binding
    // env.KV = KV namespace for secrets
    // env.API_KEY = secret from wrangler
    // env.TOTP_SECRET = secret from wrangler
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers (same as current API Gateway)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    };
    
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Rate limiting (Cloudflare makes this trivial!)
    const identifier = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitResult = await env.RATE_LIMITER.limit({ key: identifier });
    
    if (!rateLimitResult.success) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, corsHeaders);
    }
    
    try {
      // Route handling
      if (path === '/auth' && request.method === 'POST') {
        return await handleAuth(request, env, corsHeaders);
      }
      
      if (path === '/verify-totp' && request.method === 'POST') {
        return await handleTOTP(request, env, corsHeaders);
      }
      
      if (path === '/log' && request.method === 'POST') {
        return await handleLog(request, env, corsHeaders);
      }
      
      if (path === '/data' && request.method === 'GET') {
        return await handleGetData(request, env, corsHeaders);
      }
      
      if (path === '/meals' && request.method === 'GET') {
        return await handleGetMeals(request, env, corsHeaders);
      }
      
      if (path === '/meals' && request.method === 'POST') {
        return await handleSaveMeal(request, env, corsHeaders);
      }
      
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
      
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  }
};

// Authentication handler (replaces S3 password file check)
async function handleAuth(request, env, corsHeaders) {
  const { password } = await request.json();
  
  // Password stored in KV or D1
  const storedPasswordHash = await env.KV.get('PASSWORD_HASH');
  
  const isValid = await bcrypt.compare(password, storedPasswordHash);
  
  if (!isValid) {
    return jsonResponse({ error: 'Invalid password' }, 401, corsHeaders);
  }
  
  return jsonResponse({
    status: 'authenticated',
    apiKey: env.API_KEY // Return API key like current S3 file
  }, 200, corsHeaders);
}

// TOTP verification (replaces Lambda pyotp logic)
async function handleTOTP(request, env, corsHeaders) {
  const { token, deviceToken } = await request.json();
  const userId = 1; // Single user for now
  
  // Check rate limiting (3 attempts per 5 minutes)
  const attempts = await env.KV.get(`totp_attempts:${userId}`) || 0;
  
  if (attempts >= 3) {
    const ttl = await env.KV.getWithMetadata(`totp_attempts:${userId}`);
    const resetTime = ttl.metadata?.expiresAt || Date.now();
    
    return jsonResponse({
      error: 'Too many attempts',
      retry_after: Math.ceil((resetTime - Date.now()) / 1000)
    }, 429, corsHeaders);
  }
  
  // Verify TOTP
  const isValid = authenticator.verify({
    token: token,
    secret: env.TOTP_SECRET
  });
  
  if (!isValid) {
    // Increment attempts
    await env.KV.put(
      `totp_attempts:${userId}`,
      String(Number(attempts) + 1),
      { expirationTtl: 300 } // 5 minutes
    );
    
    return jsonResponse({ error: 'Invalid TOTP token' }, 401, corsHeaders);
  }
  
  // Reset attempts on success
  await env.KV.delete(`totp_attempts:${userId}`);
  
  // Generate session token
  const sessionToken = crypto.randomUUID();
  await env.KV.put(
    `session:${sessionToken}`,
    String(userId),
    { expirationTtl: 86400 } // 24 hours
  );
  
  // Handle device trust token
  if (deviceToken) {
    const deviceData = await env.DB
      .prepare('SELECT * FROM device_tokens WHERE token = ?')
      .bind(deviceToken)
      .first();
    
    if (deviceData && new Date(deviceData.expires_at) > new Date()) {
      return jsonResponse({
        status: 'success',
        session_token: sessionToken,
        trusted_device: true
      }, 200, corsHeaders);
    }
  }
  
  // Create new device trust token
  const newDeviceToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
  
  await env.DB
    .prepare('INSERT INTO device_tokens (token, user_id, device_info, expires_at) VALUES (?, ?, ?, ?)')
    .bind(newDeviceToken, userId, request.headers.get('User-Agent'), expiresAt.toISOString())
    .run();
  
  return jsonResponse({
    status: 'success',
    session_token: sessionToken,
    device_token: newDeviceToken
  }, 200, corsHeaders);
}

// Log entry handler (replaces Lambda POST logic)
async function handleLog(request, env, corsHeaders) {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey || apiKey !== env.API_KEY) {
    return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
  }
  
  const data = await request.json();
  const { date, time, type, foodName, calories, protein, exercise, weight, reps, value } = data;
  const userId = 1; // Single user
  
  // SQL is SO much cleaner than DynamoDB PK/SK gymnastics!
  if (type === 'FOOD') {
    await env.DB
      .prepare('INSERT INTO food_logs (user_id, date, time, food_name, calories, protein) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, date, time, foodName, calories || 0, protein || 0)
      .run();
  }
  else if (type === 'GYM') {
    await env.DB
      .prepare('INSERT INTO gym_logs (user_id, date, time) VALUES (?, ?, ?)')
      .bind(userId, date, time)
      .run();
  }
  else if (type === 'EXERCISE') {
    await env.DB
      .prepare('INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, date, time, exercise, weight, reps)
      .run();
  }
  else if (type === 'ACTIVE' || type === 'WEIGHT' || type === 'SLEEP') {
    // Upsert daily metric (ON CONFLICT UPDATE)
    await env.DB
      .prepare(`
        INSERT INTO daily_metrics (user_id, date, metric_type, value)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value
      `)
      .bind(userId, date, type, value)
      .run();
  }
  
  return jsonResponse({ status: 'success' }, 200, corsHeaders);
}

// Get data handler (replaces Lambda GET logic)
async function handleGetData(request, env, corsHeaders) {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey || apiKey !== env.API_KEY) {
    return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
  }
  
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const userId = 1;
  
  // Look at these beautiful SQL queries instead of DynamoDB scans!
  const [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
    env.DB
      .prepare('SELECT * FROM food_logs WHERE user_id = ? AND date = ? ORDER BY time')
      .bind(userId, date)
      .all(),
    
    env.DB
      .prepare('SELECT * FROM gym_logs WHERE user_id = ? AND date = ? ORDER BY time')
      .bind(userId, date)
      .all(),
    
    env.DB
      .prepare('SELECT * FROM exercise_logs WHERE user_id = ? AND date = ? ORDER BY time')
      .bind(userId, date)
      .all(),
    
    env.DB
      .prepare('SELECT metric_type, value FROM daily_metrics WHERE user_id = ? AND date = ?')
      .bind(userId, date)
      .all()
  ]);
  
  // Transform to match current frontend format
  const items = [];
  
  foodLogs.results?.forEach(log => {
    items.push({
      date: log.date,
      type: 'FOOD',
      time: log.time,
      foodName: log.food_name,
      calories: log.calories,
      protein: log.protein
    });
  });
  
  gymLogs.results?.forEach(log => {
    items.push({
      date: log.date,
      type: 'GYM',
      time: log.time
    });
  });
  
  exerciseLogs.results?.forEach(log => {
    items.push({
      date: log.date,
      type: 'EXERCISE',
      time: log.time,
      exercise: log.exercise_name,
      weight: log.weight_kg,
      reps: log.reps
    });
  });
  
  dailyMetrics.results?.forEach(metric => {
    items.push({
      date: date,
      type: metric.metric_type,
      value: metric.value
    });
  });
  
  return jsonResponse({ items }, 200, corsHeaders);
}

// Get meals handler
async function handleGetMeals(request, env, corsHeaders) {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey || apiKey !== env.API_KEY) {
    return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
  }
  
  const userId = 1;
  
  const result = await env.DB
    .prepare('SELECT meal_name, calories, protein FROM saved_meals WHERE user_id = ? ORDER BY meal_name')
    .bind(userId)
    .all();
  
  return jsonResponse({ meals: result.results || [] }, 200, corsHeaders);
}

// Save meal handler
async function handleSaveMeal(request, env, corsHeaders) {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey || apiKey !== env.API_KEY) {
    return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
  }
  
  const { mealName, calories, protein } = await request.json();
  const userId = 1;
  
  await env.DB
    .prepare(`
      INSERT INTO saved_meals (user_id, meal_name, calories, protein)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, meal_name) DO UPDATE SET
        calories = excluded.calories,
        protein = excluded.protein
    `)
    .bind(userId, mealName, calories || 0, protein || 0)
    .run();
  
  return jsonResponse({ status: 'success' }, 200, corsHeaders);
}

// Utility function
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

// --- wrangler.toml configuration ---
// name = "fitness-tracker-worker"
// main = "src/index.js"
// compatibility_date = "2024-01-01"
//
// [[d1_databases]]
// binding = "DB"
// database_name = "fitness-tracker-db"
// database_id = "YOUR_DATABASE_ID"
//
// [[kv_namespaces]]
// binding = "KV"
// id = "YOUR_KV_ID"
//
// [[unsafe.bindings]]
// name = "RATE_LIMITER"
// type = "ratelimit"
// namespace_id = "YOUR_RATE_LIMITER_ID"
// simple = { limit = 20, period = 1 }

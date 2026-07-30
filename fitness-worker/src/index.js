// Cloudflare Worker - Fitness Tracker API
// Replaces AWS Lambda with D1 SQL database
import { verify } from 'otplib';

const API_KEY = 'my_secret_token_123'; 

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight early
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    try {
      const response = await handleApiRequest(request, env);
      
      // Ensure we have a Response object
      if (!(response instanceof Response)) {
        return new Response(JSON.stringify({ error: 'Internal Server Error: Invalid response type' }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      // CLONING THE RESPONSE HEADERS IS CRITICAL
      // Using new Headers(response.headers) can sometimes skip the spread if the object is sealed
      const finalHeaders = new Headers();
      // 1. Add CORS headers first
      Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
      // 2. Add original headers (careful not to override CORS if the handler tried to set them)
      response.headers.forEach((v, k) => {
        if (!k.toLowerCase().startsWith('access-control-')) {
          finalHeaders.set(k, v);
        }
      });
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: finalHeaders
      });
    } catch (err) {
      console.error('Fatal Worker Error:', err);
      return new Response(JSON.stringify({ 
        error: err.message,
        stack: err.stack 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, ''); // Normalize: remove trailing slash
  const method = request.method;

  // Helper for JSON responses (used only within handleApiRequest)
  const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  // Auth helper inside handleApiRequest
  const getApiKey = () => {
    return request.headers.get('X-API-Key') || request.headers.get('x-api-key') || url.searchParams.get('key') || url.searchParams.get('apiKey');
  };

  const isAuthorized = async () => {
    const providedKey = getApiKey();
    if (!providedKey) return false;
    if (providedKey === API_KEY) return true;
    
    const dbKey = await env.DB.prepare(
      'SELECT config_value FROM auth_config WHERE config_key = ?'
    ).bind('api_key').first();
    
    return dbKey && providedKey === dbKey.config_value;
  };

  // ROUTES
  
  // GET /search (Proxy to Open Food Facts to avoid CORS)
  if (path === '/search' && method === 'GET') {
    const query = url.searchParams.get('q');
    if (!query) return jsonResponse({ products: [] });

    try {
      const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10`;
      const offRes = await fetch(offUrl, {
        headers: { 'User-Agent': 'FitnessTrackerApp - Web - 1.0' }
      });
      const offData = await offRes.json();
      return jsonResponse(offData);
    } catch (e) {
      console.error('OFF Proxy Error:', e);
      return jsonResponse({ error: 'Search failed' }, 500);
    }
  }

  // Health check
  if (path === '/health' || path === '') {
    return jsonResponse({
      status: 'healthy-v5',
      service: 'fitness-tracker-worker',
      timestamp: new Date().toISOString()
    });
  }

  // POST /auth
  if (path === '/auth' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const password = body.password;
    if (!password) return jsonResponse({ error: 'Password required' }, 400);

    const storedPassword = await env.DB.prepare(
      'SELECT config_value FROM auth_config WHERE config_key = ?'
    ).bind('password').first();
    
    if (storedPassword && storedPassword.config_value === password) {
      const apiKey = await env.DB.prepare(
        'SELECT config_value FROM auth_config WHERE config_key = ?'
      ).bind('api_key').first();
      
      return jsonResponse({
        status: 'authenticated',
        apiKey: apiKey?.config_value || API_KEY
      });
    } else {
      return jsonResponse({ error: 'Invalid password' }, 401);
    }
  }

  // POST /verify-totp
  if (path === '/verify-totp' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { code, deviceFingerprint } = body;
    if (!code) return jsonResponse({ error: 'Code required' }, 400);

    const fingerprint = deviceFingerprint || 'unknown';
    const now = new Date();
    
    // Check rate limit
    const rateLimit = await env.DB.prepare(`
      SELECT failed_attempts, last_attempt, locked_until FROM totp_rate_limit WHERE device_fingerprint = ?
    `).bind(fingerprint).first();
    
    if (rateLimit) {
      const lockedUntil = rateLimit.locked_until ? new Date(rateLimit.locked_until) : null;
      if (lockedUntil && now < lockedUntil) {
        return jsonResponse({ 
          error: `Locked for ${Math.ceil((lockedUntil - now) / 1000)}s`,
          locked_until: lockedUntil.toISOString()
        }, 429);
      }
    }

    const secretRow = await env.DB.prepare(
      'SELECT config_value FROM auth_config WHERE config_key = ?'
    ).bind('totp_secret').first();
    
    if (!secretRow?.config_value) return jsonResponse({ error: 'TOTP not configured' }, 500);
    
    const isValid = await verify({ token: code, secret: secretRow.config_value });
    
    if (isValid) {
      await env.DB.prepare('DELETE FROM totp_rate_limit WHERE device_fingerprint = ?').bind(fingerprint).run();
      return jsonResponse({ success: true, message: 'TOTP verified' });
    } else {
      const attempts = (rateLimit?.failed_attempts || 0) + 1;
      const lock = attempts >= 3 ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() : null;
      await env.DB.prepare(`
        INSERT INTO totp_rate_limit (device_fingerprint, failed_attempts, last_attempt, locked_until)
        VALUES (?, ?, ?, ?) ON CONFLICT(device_fingerprint) DO UPDATE SET
        failed_attempts = excluded.failed_attempts, last_attempt = excluded.last_attempt, locked_until = excluded.locked_until
      `).bind(fingerprint, attempts, now.toISOString(), lock).run();
      return jsonResponse({ success: false, error: 'Invalid code', attempts_remaining: Math.max(0, 3 - attempts) }, 401);
    }
  }

  // ALL OTHER ROUTES REQUIRE AUTH
  const authorized = await isAuthorized();
  if (!authorized) {
    return jsonResponse({ 
      error: 'Invalid API key', 
      path,
      provided: getApiKey()?.substring(0, 3) + '...' 
    }, 401);
  }

  const userId = 1;

  // POST /log
  if (path === '/log' && method === 'POST') {
    let data;
    try {
      data = await request.json();
    } catch (e) {
      console.error('POST /log JSON Parse Error:', e);
      return jsonResponse({ error: 'Invalid or empty JSON payload' }, 400);
    }
    
    if (!data) return jsonResponse({ error: 'Data is missing' }, 400);

    const { date, time, type, foodName, note, calories, value, protein, exercise, weight, reps, amount, amountUnit, nutrients } = data;
    if (!date) return jsonResponse({ error: 'Date is required' }, 400);

    const finalFoodName = foodName || note || '';
    const finalCalories = calories !== undefined ? calories : (value || 0);
    const nutrientsJson = nutrients ? JSON.stringify(nutrients) : null;
    
    // Ensure time is never null/empty for the database
    let finalTime = time;
    if (!finalTime || finalTime.trim() === '') {
      finalTime = new Date().toISOString().split('T')[1].split('.')[0];
    }

    try {
      if (type === 'FOOD') {
        await env.DB.prepare(`
          INSERT INTO food_logs (user_id, date, time, food_name, calories, protein, amount, amount_unit, nutrients_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(userId, date, finalTime, finalFoodName, Number(finalCalories), Number(protein || 0), amount || null, amountUnit || null, nutrientsJson).run();
      } else if (type === 'GYM') {
        await env.DB.prepare(`
          INSERT INTO gym_logs (user_id, date, time)
          VALUES (?, ?, ?)
        `).bind(userId, date, finalTime).run();
      } else if (type === 'EXERCISE') {
        await env.DB.prepare(`
          INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(userId, date, finalTime, exercise || 'Exercise', Number(weight || 0), Number(reps || 0)).run();
      } else if (['ACTIVE', 'WEIGHT', 'SLEEP'].includes(type)) {
        await env.DB.prepare(`
          INSERT INTO daily_metrics (user_id, date, metric_type, value)
          VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value
        `).bind(userId, date, type, Number(value || 0)).run();
      } else if (type === 'METRIC') {
        // Fallback for generic METRIC type if sent
        const metricType = data.metricType || 'ACTIVE';
        await env.DB.prepare(`
          INSERT INTO daily_metrics (user_id, date, metric_type, value)
          VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value
        `).bind(userId, date, metricType, Number(value || 0)).run();
      }
      return jsonResponse({ status: 'success' });
    } catch (e) {
      console.error('D1 Insert Error:', e);
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // DELETE /log
  if (path === '/log' && method === 'DELETE') {
    let logId = url.searchParams.get('id');
    let type = url.searchParams.get('type');
    const pk = url.searchParams.get('pk');
    const sk = url.searchParams.get('sk');

    if (pk && sk) {
      const parts = sk.split('#');
      type = parts[0];
      if (type === 'METRIC') type = parts[1];
      else logId = parts[parts.length - 1];
    }

    if (!type) return jsonResponse({ error: 'Missing type' }, 400);

    if (type === 'FOOD') {
      await env.DB.prepare('DELETE FROM food_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
    } else if (type === 'GYM') {
      await env.DB.prepare('DELETE FROM gym_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
    } else if (type === 'EXERCISE') {
      await env.DB.prepare('DELETE FROM exercise_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
    } else if (['ACTIVE', 'WEIGHT', 'SLEEP'].includes(type)) {
      await env.DB.prepare('DELETE FROM daily_metrics WHERE user_id = ? AND date = ? AND metric_type = ?').bind(userId, pk, type).run();
    }
    return jsonResponse({ status: 'success' });
  }

  // GET /data
  if (path === '/data' && method === 'GET') {
    const date = url.searchParams.get('date');
    let foodLogs, gymLogs, exerciseLogs, dailyMetrics;

    if (date) {
      [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
        env.DB.prepare('SELECT * FROM food_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
        env.DB.prepare('SELECT * FROM gym_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
        env.DB.prepare('SELECT * FROM exercise_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
        env.DB.prepare('SELECT * FROM daily_metrics WHERE user_id = ? AND date = ?').bind(userId, date).all()
      ]);
    } else {
      [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
        env.DB.prepare('SELECT * FROM food_logs WHERE user_id = ? ORDER BY date DESC, time DESC LIMIT 1000').bind(userId).all(),
        env.DB.prepare('SELECT * FROM gym_logs WHERE user_id = ? ORDER BY date DESC, time DESC LIMIT 200').bind(userId).all(),
        env.DB.prepare('SELECT * FROM exercise_logs WHERE user_id = ? ORDER BY date DESC, time DESC LIMIT 1000').bind(userId).all(),
        env.DB.prepare('SELECT * FROM daily_metrics WHERE user_id = ? ORDER BY date DESC LIMIT 500').bind(userId).all()
      ]);
    }

    const items = [];
    foodLogs.results?.forEach(l => items.push({ 
      PK: l.date, 
      SK: `FOOD#${l.time}#${l.log_id}`, 
      Type: 'FOOD', 
      Value: l.calories, 
      Protein: l.protein, 
      Date: l.date, 
      Time: l.time, 
      Note: l.food_name, 
      logId: l.log_id,
      Nutrients: l.nutrients_json
    }));
    gymLogs.results?.forEach(l => items.push({ PK: l.date, SK: `GYM#${l.time}#${l.log_id}`, Type: 'GYM', Date: l.date, Time: l.time, logId: l.log_id }));
    exerciseLogs.results?.forEach(l => items.push({ PK: l.date, SK: `EXERCISE#${l.time}#${l.log_id}`, Type: 'EXERCISE', Date: l.date, Time: l.time, Exercise: l.exercise_name, Weight: l.weight_kg, Reps: l.reps, logId: l.log_id }));
    dailyMetrics.results?.forEach(m => items.push({ PK: m.date, SK: `METRIC#${m.metric_type}`, Type: m.metric_type, Value: m.value, Date: m.date }));

    return jsonResponse({ items, baseline: 1800 });
  }

  // GET /meals
  if (path === '/meals' && method === 'GET') {
    const mealsResult = await env.DB.prepare('SELECT * FROM meals WHERE user_id = ? ORDER BY meal_name').bind(userId).all();
    const meals = mealsResult.results || [];
    
    // Fetch all ingredients for these meals
    const mealIds = meals.map(m => m.meal_id);
    let allIngredients = [];
    if (mealIds.length > 0) {
      const placeholders = mealIds.map(() => '?').join(',');
      const ingResult = await env.DB.prepare(`SELECT * FROM ingredients WHERE meal_id IN (${placeholders})`).bind(...mealIds).all();
      allIngredients = ingResult.results || [];
    }

    const formattedMeals = meals.map(m => {
      const mealIngredients = allIngredients.filter(i => i.meal_id === m.meal_id);
      
      // Calculate totals on the fly
      const totalCalories = mealIngredients.reduce((sum, i) => sum + i.calories, 0);
      const totalProtein = mealIngredients.reduce((sum, i) => sum + i.protein, 0);

      return {
        mealId: m.meal_id,
        MealName: m.meal_name,
        Calories: totalCalories,
        Protein: totalProtein,
        Portions: m.portions || 1,
        isQuickFood: m.is_quick_food === 1,
        Ingredients: mealIngredients.map(i => ({
          desc: i.name,
          qty: i.amount,
          unit: i.amount_units,
          cals: i.calories,
          pro: i.protein,
          nutrients: i.nutrients_json ? JSON.parse(i.nutrients_json) : null
        }))
      };
    });
    
    return jsonResponse({ meals: formattedMeals });
  }

  // POST /meals
  if (path === '/meals' && method === 'POST') {
    const data = await request.json().catch(() => ({}));
    const { name, mealName, portions, ingredients, isQuickFood } = data;
    const finalName = name || mealName;
    if (!finalName) return jsonResponse({ error: 'Meal name required' }, 400);

    // Insert or update the meal header
    const result = await env.DB.prepare(`
      INSERT INTO meals (user_id, meal_name, portions, is_quick_food, modified_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, meal_name) DO UPDATE SET
      portions = excluded.portions, 
      is_quick_food = excluded.is_quick_food,
      modified_at = CURRENT_TIMESTAMP
      RETURNING meal_id
    `).bind(userId, finalName, Number(portions || 1), isQuickFood ? 1 : 0).first();

    const mealId = result.meal_id;

    // Delete existing ingredients for this meal
    await env.DB.prepare('DELETE FROM ingredients WHERE meal_id = ?').bind(mealId).run();

    // Insert new ingredients
    if (ingredients && Array.isArray(ingredients)) {
      for (const ing of ingredients) {
        if (ing.desc || isQuickFood) {
          await env.DB.prepare(`
            INSERT INTO ingredients (meal_id, name, amount, amount_units, calories, protein, nutrients_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mealId, 
            ing.desc || finalName, 
            Number(ing.qty || 0), 
            ing.unit || 'g', 
            Number(ing.cals || 0), 
            Number(ing.pro || 0),
            ing.nutrients ? JSON.stringify(ing.nutrients) : null
          ).run();
        }
      }
    }

    return jsonResponse({ status: 'success', mealId });
  }

  // DELETE /meals
  if (path === '/meals' && method === 'DELETE') {
    const name = url.searchParams.get('name');
    if (!name) return jsonResponse({ error: 'Missing name' }, 400);
    // Cascade delete handles ingredients
    await env.DB.prepare('DELETE FROM meals WHERE user_id = ? AND meal_name = ?').bind(userId, name).run();
    return jsonResponse({ status: 'success' });
  }

  // GET /config
  if (path === '/config' && method === 'GET') {
    const result = await env.DB.prepare("SELECT config_value, effective_date FROM user_config WHERE user_id = ? AND config_key = 'goals' ORDER BY effective_date DESC").bind(userId).all();
    if (!result.results?.length) {
      return jsonResponse({ goals: { weeklyNet: -3850, weeklyComparison: 'less', protein: 80, sleep: 75, gym: 2 }, history: [] });
    }
    const currentGoals = JSON.parse(result.results[0].config_value);
    const history = result.results.map(row => ({ ...JSON.parse(row.config_value), effectiveDate: row.effective_date }));
    return jsonResponse({ goals: currentGoals, history });
  }

  // POST /config
  if (path === '/config' && method === 'POST') {
    const data = await request.json().catch(() => ({}));
    const { goals, effectiveDate } = data;
    if (!goals) return jsonResponse({ error: 'Goals required' }, 400);
    const date = effectiveDate || new Date().toISOString().split('T')[0];
    await env.DB.prepare(`
      INSERT INTO user_config (user_id, config_key, config_value, effective_date)
      VALUES (?, 'goals', ?, ?) ON CONFLICT(user_id, config_key, effective_date) DO UPDATE SET config_value = excluded.config_value
    `).bind(userId, JSON.stringify(goals), date).run();
    return jsonResponse({ status: 'success' });
  }

  // POST /trust-device
  if (path === '/trust-device' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { deviceFingerprint } = body;
    if (!deviceFingerprint) return jsonResponse({ error: 'Fingerprint required' }, 400);
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(`
      INSERT INTO device_tokens_v2 (device_fingerprint, user_id, device_token, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(device_fingerprint) DO UPDATE SET device_token = excluded.device_token, expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP
    `).bind(deviceFingerprint, userId, token, expires).run();
    return jsonResponse({ success: true, deviceToken: token, expiresAt: expires });
  }

  // GET /trust-device
  if (path === '/trust-device' && method === 'GET') {
    const fp = url.searchParams.get('deviceFingerprint');
    const token = url.searchParams.get('deviceToken');
    if (!fp || !token) return jsonResponse({ trusted: false });
    const result = await env.DB.prepare('SELECT device_token, expires_at FROM device_tokens_v2 WHERE device_fingerprint = ?').bind(fp).first();
    const valid = result && result.device_token === token && new Date(result.expires_at) > new Date();
    return jsonResponse({ trusted: !!valid });
  }

  return jsonResponse({ error: 'Not found', path, method }, 404);
}


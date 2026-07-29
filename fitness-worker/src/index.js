// Cloudflare Worker - Fitness Tracker API
// Replaces AWS Lambda with D1 SQL database

const API_KEY = 'my_secret_token_123'; // Temporary - will move to secrets

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers (same as your current API)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };
    
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // Health check
      if (url.pathname === '/health') {
        return jsonResponse({
          status: 'healthy',
          service: 'fitness-tracker-worker',
          timestamp: new Date().toISOString()
        }, 200, corsHeaders);
      }
      
      // Test endpoint
      if (url.pathname === '/test' && request.method === 'GET') {
        const date = url.searchParams.get('date') || '2026-07-29';
        const result = await env.DB.prepare(`
          SELECT 
            COUNT(*) as entries,
            SUM(calories) as total_calories,
            SUM(protein) as total_protein
          FROM food_logs
          WHERE date = ?
        `).bind(date).first();
        
        return jsonResponse({
          status: 'success',
          date: date,
          data: result
        }, 200, corsHeaders);
      }
      
      // POST /auth - Secure password authentication (password in request body, NOT URL!)
      if (url.pathname === '/auth' && request.method === 'POST') {
        const body = await request.json();
        const password = body.password;
        
        if (!password) {
          return jsonResponse({ error: 'Password required' }, 400, corsHeaders);
        }
        
        // Check password against D1
        const storedPassword = await env.DB.prepare(
          'SELECT config_value FROM auth_config WHERE config_key = ?'
        ).bind('password').first();
        
        if (storedPassword && storedPassword.config_value === password) {
          // Password correct - return API key
          const apiKey = await env.DB.prepare(
            'SELECT config_value FROM auth_config WHERE config_key = ?'
          ).bind('api_key').first();
          
          return jsonResponse({
            status: 'authenticated',
            apiKey: apiKey?.config_value || API_KEY
          }, 200, corsHeaders);
        } else {
          // Password incorrect - return 401 Unauthorized
          return jsonResponse({ 
            error: 'Invalid password' 
          }, 401, corsHeaders);
        }
      }
      
      // POST /log - Log food/gym/exercise entry
      if (url.pathname === '/log' && request.method === 'POST') {
        // Validate API key
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const data = await request.json();
        const { date, time, type, foodName, calories, protein, exercise, weight, reps, value } = data;
        const userId = 1; // Single user for now
        
        // SQL is SO much cleaner than DynamoDB!
        if (type === 'FOOD') {
          await env.DB.prepare(`
            INSERT INTO food_logs (user_id, date, time, food_name, calories, protein)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(userId, date, time, foodName || '', calories || 0, protein || 0).run();
        }
        else if (type === 'GYM') {
          await env.DB.prepare(`
            INSERT INTO gym_logs (user_id, date, time)
            VALUES (?, ?, ?)
          `).bind(userId, date, time).run();
        }
        else if (type === 'EXERCISE') {
          await env.DB.prepare(`
            INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(userId, date, time, exercise || '', weight || 0, reps || 0).run();
        }
        else if (type === 'ACTIVE' || type === 'WEIGHT' || type === 'SLEEP') {
          // Upsert daily metric (ON CONFLICT UPDATE)
          await env.DB.prepare(`
            INSERT INTO daily_metrics (user_id, date, metric_type, value)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value
          `).bind(userId, date, type, value || 0).run();
        }
        
        return jsonResponse({ status: 'success' }, 200, corsHeaders);
      }
      
      // GET /data - Get all data for a date
      if (url.pathname === '/data' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const date = url.searchParams.get('date');
        if (!date) {
          return jsonResponse({ error: 'Missing date parameter' }, 400, corsHeaders);
        }
        
        const userId = 1;
        
        // Parallel queries - much faster than sequential DynamoDB scans!
        const [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
          env.DB.prepare('SELECT * FROM food_logs WHERE user_id = ? AND date = ? ORDER BY time')
            .bind(userId, date).all(),
          env.DB.prepare('SELECT * FROM gym_logs WHERE user_id = ? AND date = ? ORDER BY time')
            .bind(userId, date).all(),
          env.DB.prepare('SELECT * FROM exercise_logs WHERE user_id = ? AND date = ? ORDER BY time')
            .bind(userId, date).all(),
          env.DB.prepare('SELECT metric_type, value FROM daily_metrics WHERE user_id = ? AND date = ?')
            .bind(userId, date).all()
        ]);
        
        // Transform to match your frontend format
        const items = [];
        
        foodLogs.results?.forEach(log => {
          items.push({
            PK: log.date,  // For compatibility with frontend
            SK: `FOOD#${log.time}`,  // For compatibility
            logId: log.log_id,  // For delete operations
            date: log.date,
            type: 'FOOD',
            time: log.time,
            foodName: log.food_name,
            calories: log.calories,
            protein: log.protein,
            Note: log.food_name  // Alias for compatibility
          });
        });
        
        gymLogs.results?.forEach(log => {
          items.push({
            PK: log.date,
            SK: `GYM#${log.time}`,
            logId: log.log_id,
            date: log.date,
            type: 'GYM',
            time: log.time
          });
        });
        
        exerciseLogs.results?.forEach(log => {
          items.push({
            PK: log.date,
            SK: `EXERCISE#${log.time}`,
            logId: log.log_id,
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
      
      // GET /meals - Get saved meals
      if (url.pathname === '/meals' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const userId = 1;
        const result = await env.DB.prepare(`
          SELECT meal_name, calories, protein 
          FROM saved_meals 
          WHERE user_id = ? 
          ORDER BY meal_name
        `).bind(userId).all();
        
        return jsonResponse({ meals: result.results || [] }, 200, corsHeaders);
      }
      
      // POST /meals - Save a meal
      if (url.pathname === '/meals' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const { mealName, calories, protein } = await request.json();
        const userId = 1;
        
        await env.DB.prepare(`
          INSERT INTO saved_meals (user_id, meal_name, calories, protein)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, meal_name) DO UPDATE SET
            calories = excluded.calories,
            protein = excluded.protein
        `).bind(userId, mealName, calories || 0, protein || 0).run();
        
        return jsonResponse({ status: 'success' }, 200, corsHeaders);
      }
      
      // DELETE /meals - Delete a saved meal
      if (url.pathname === '/meals' && request.method === 'DELETE') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const mealName = url.searchParams.get('name');
        if (!mealName) {
          return jsonResponse({ error: 'Missing name parameter' }, 400, corsHeaders);
        }
        
        const userId = 1;
        await env.DB.prepare('DELETE FROM saved_meals WHERE user_id = ? AND meal_name = ?')
          .bind(userId, mealName).run();
        
        return jsonResponse({ status: 'success' }, 200, corsHeaders);
      }
      
      // DELETE /log - Delete a log entry
      if (url.pathname === '/log' && request.method === 'DELETE') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const logId = url.searchParams.get('id');
        const type = url.searchParams.get('type');
        
        if (!logId || !type) {
          return jsonResponse({ error: 'Missing id or type parameter' }, 400, corsHeaders);
        }
        
        const userId = 1;
        
        // Delete from appropriate table based on type
        if (type === 'FOOD') {
          await env.DB.prepare('DELETE FROM food_logs WHERE user_id = ? AND log_id = ?')
            .bind(userId, logId).run();
        } else if (type === 'GYM') {
          await env.DB.prepare('DELETE FROM gym_logs WHERE user_id = ? AND log_id = ?')
            .bind(userId, logId).run();
        } else if (type === 'EXERCISE') {
          await env.DB.prepare('DELETE FROM exercise_logs WHERE user_id = ? AND log_id = ?')
            .bind(userId, logId).run();
        } else if (type === 'ACTIVE' || type === 'WEIGHT' || type === 'SLEEP') {
          await env.DB.prepare('DELETE FROM daily_metrics WHERE user_id = ? AND metric_type = ?')
            .bind(userId, type).run();
        }
        
        return jsonResponse({ status: 'success' }, 200, corsHeaders);
      }
      
      // POST /config - Save goals configuration
      if (url.pathname === '/config' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const body = await request.json();
        const { goals, effectiveDate } = body;
        const userId = 1;
        
        // Store each goal with effective date for historical tracking
        const date = effectiveDate || new Date().toISOString().split('T')[0];
        const goalsJson = JSON.stringify(goals);
        
        await env.DB.prepare(`
          INSERT INTO user_config (user_id, config_key, config_value, effective_date)
          VALUES (?, 'goals', ?, ?)
          ON CONFLICT(user_id, config_key, effective_date) DO UPDATE SET
            config_value = excluded.config_value
        `).bind(userId, goalsJson, date).run();
        
        return jsonResponse({ status: 'success' }, 200, corsHeaders);
      }
      
      // GET /config - Get goals configuration with history
      if (url.pathname === '/config' && request.method === 'GET') {
        const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const userId = 1;
        
        // Get all goals history ordered by date
        const result = await env.DB.prepare(`
          SELECT config_value, effective_date 
          FROM user_config 
          WHERE user_id = ? AND config_key = 'goals'
          ORDER BY effective_date DESC
        `).bind(userId).all();
        
        if (!result.results || result.results.length === 0) {
          // Return default goals if none exist
          return jsonResponse({
            goals: {
              weeklyNet: -3850,
              weeklyComparison: 'less',
              protein: 80,
              sleep: 75,
              gym: 2
            },
            history: []
          }, 200, corsHeaders);
        }
        
        // Parse the most recent goals
        const currentGoals = JSON.parse(result.results[0].config_value);
        
        // Build history array
        const history = result.results.map(row => {
          const goals = JSON.parse(row.config_value);
          return {
            ...goals,
            effectiveDate: row.effective_date
          };
        });
        
        return jsonResponse({
          goals: currentGoals,
          history: history
        }, 200, corsHeaders);
      }
      
      // POST /trust-device - Create trusted device token
      if (url.pathname === '/trust-device' && request.method === 'POST') {
        const apiKey = request.headers.get('X-API-Key');
        if (!apiKey || apiKey !== API_KEY) {
          return jsonResponse({ error: 'Invalid API key' }, 401, corsHeaders);
        }
        
        const body = await request.json();
        const deviceFingerprint = body.deviceFingerprint;
        
        if (!deviceFingerprint) {
          return jsonResponse({ error: 'Device fingerprint required' }, 400, corsHeaders);
        }
        
        const userId = 1;
        // Generate secure token
        const deviceToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days
        
        await env.DB.prepare(`
          INSERT INTO device_tokens_v2 (device_fingerprint, user_id, device_token, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(device_fingerprint) DO UPDATE SET
            device_token = excluded.device_token,
            expires_at = excluded.expires_at,
            created_at = CURRENT_TIMESTAMP
        `).bind(deviceFingerprint, userId, deviceToken, expiresAt).run();
        
        return jsonResponse({
          success: true,
          deviceToken: deviceToken,
          expiresAt: expiresAt
        }, 200, corsHeaders);
      }
      
      // GET /trust-device - Check if device is trusted
      if (url.pathname === '/trust-device' && request.method === 'GET') {
        const deviceFingerprint = url.searchParams.get('deviceFingerprint');
        const deviceToken = url.searchParams.get('deviceToken');
        
        if (!deviceFingerprint || !deviceToken) {
          return jsonResponse({ trusted: false }, 200, corsHeaders);
        }
        
        const result = await env.DB.prepare(`
          SELECT device_token, expires_at 
          FROM device_tokens_v2 
          WHERE device_fingerprint = ?
        `).bind(deviceFingerprint).first();
        
        if (!result) {
          return jsonResponse({ trusted: false }, 200, corsHeaders);
        }
        
        // Check token matches and hasn't expired
        const isValid = result.device_token === deviceToken && 
                       new Date(result.expires_at) > new Date();
        
        return jsonResponse({ trusted: isValid }, 200, corsHeaders);
      }
      
      return jsonResponse({
        error: 'Not found',
        available_endpoints: [
          'POST /auth',
          'GET /health',
          'GET /test?date=YYYY-MM-DD',
          'POST /log',
          'DELETE /log?id=ID&type=TYPE',
          'GET /data?date=YYYY-MM-DD',
          'GET /meals',
          'POST /meals',
          'DELETE /meals?name=NAME',
          'POST /config',
          'GET /config',
          'POST /trust-device',
          'GET /trust-device?deviceFingerprint=FP&deviceToken=TOKEN'
        ]
      }, 404, corsHeaders);
      
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({
        error: error.message,
        stack: error.stack
      }, 500, corsHeaders);
    }
  }
};

// Helper function
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

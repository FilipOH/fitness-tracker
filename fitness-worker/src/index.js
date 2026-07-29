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
      
      return jsonResponse({
        error: 'Not found',
        available_endpoints: [
          'GET /health',
          'GET /test?date=YYYY-MM-DD',
          'POST /log',
          'GET /data?date=YYYY-MM-DD',
          'GET /meals',
          'POST /meals'
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

// Cloudflare Worker - Fitness Tracker API
// Replaces AWS Lambda with D1 SQL database
import { verify } from 'otplib';

const API_KEY = 'my_secret_token_123'; // Temporary - will move to secrets

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ''); // Remove trailing slash
    
    // Define CORS headers once at the top
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: corsHeaders 
      });
    }

    // Wrap the response helper to always include CORS headers
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    };
    
    try {
      console.log(`Request: ${request.method} ${path}`);
      
      // Helper to check for API key in headers or query
      const getApiKey = () => {
        return request.headers.get('X-API-Key') || url.searchParams.get('key') || url.searchParams.get('apiKey');
      };

      // AUTH CHECK HELPER
      const isAuthorized = async () => {
        const providedKey = getApiKey();
        
        if (!providedKey) return false;
        
        // Match against constant OR database
        if (providedKey === API_KEY) return true;
        
        const dbKey = await env.DB.prepare(
          'SELECT config_value FROM auth_config WHERE config_key = ?'
        ).bind('api_key').first();
        
        return dbKey && providedKey === dbKey.config_value;
      };

      // Health check
      if (path === '/health') {
        return jsonResponse({
          status: 'healthy-v3',
          timestamp: new Date().toISOString()
        });
      }
      
      // Test endpoint
      if (path === '/test' && request.method === 'GET') {
        const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
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
        });
      }
      
      // POST /auth - Secure password authentication (password in request body, NOT URL!)
      if (url.pathname === '/auth' && request.method === 'POST') {
        const body = await request.json();
        const password = body.password;
        
        if (!password) {
          return jsonResponse({ error: 'Password required' }, 400);
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
          });
        } else {
          // Password incorrect - return 401 Unauthorized
          return jsonResponse({ 
            error: 'Invalid password' 
          }, 401);
        }
      }
      
      // POST /verify-totp - Verify TOTP/MFA code with rate limiting
      if (url.pathname === '/verify-totp' && request.method === 'POST') {
        try {
          const body = await request.json();
          const { code, deviceFingerprint } = body;
          
          if (!code) {
            return jsonResponse({ error: 'Code required' }, 400, corsHeaders);
          }
          
          const fingerprint = deviceFingerprint || 'unknown';
          const now = new Date();
          
          // SECURITY: Check rate limiting - max 3 failed attempts per 5 minutes
          const rateLimitCheck = await env.DB.prepare(`
            SELECT failed_attempts, last_attempt, locked_until
            FROM totp_rate_limit
            WHERE device_fingerprint = ?
          `).bind(fingerprint).first();
          
          if (rateLimitCheck) {
            const lockedUntil = rateLimitCheck.locked_until ? new Date(rateLimitCheck.locked_until) : null;
            
            // Check if currently locked out
            if (lockedUntil && now < lockedUntil) {
              const remainingSeconds = Math.ceil((lockedUntil - now) / 1000);
              return jsonResponse({ 
                error: `Too many failed attempts. Locked for ${remainingSeconds} more seconds.`,
                locked_until: lockedUntil.toISOString()
              }, 429, corsHeaders);
            }
            
            // Check if within 5 minute window and exceeded attempts
            const lastAttempt = new Date(rateLimitCheck.last_attempt);
            const timeSinceLastAttempt = (now - lastAttempt) / 1000 / 60; // minutes
            
            if (timeSinceLastAttempt < 5 && rateLimitCheck.failed_attempts >= 3) {
              return jsonResponse({ 
                error: 'Too many attempts. Please wait 5 minutes.' 
              }, 429, corsHeaders);
            }
          }
          
          // Get TOTP secret from D1
          const secretRow = await env.DB.prepare(
            'SELECT config_value FROM auth_config WHERE config_key = ?'
          ).bind('totp_secret').first();
          
          if (!secretRow || !secretRow.config_value) {
            return jsonResponse({ error: 'TOTP not configured' }, 500);
          }
          
          // Verify the TOTP code using otplib functional API
          // Returns VerifyResult { valid: boolean, delta?: number }
          const result = await verify({ 
            token: code, 
            secret: secretRow.config_value 
          });
          
          if (result.valid) {
            // SUCCESS: Clear rate limit record
            await env.DB.prepare(
              'DELETE FROM totp_rate_limit WHERE device_fingerprint = ?'
            ).bind(fingerprint).run();
            
            return jsonResponse({ 
              success: true, 
              message: 'TOTP verified' 
            });
          } else {
            // FAIL: Increment rate limit counter
            const currentAttempts = rateLimitCheck?.failed_attempts || 0;
            const newAttempts = (rateLimitCheck && 
              (now - new Date(rateLimitCheck.last_attempt)) / 1000 / 60 < 5) 
              ? currentAttempts + 1 
              : 1;
            
            // Lock for 5 minutes if this is the 3rd failed attempt
            const lockedUntil = newAttempts >= 3 
              ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() 
              : null;
            
            await env.DB.prepare(`
              INSERT INTO totp_rate_limit (device_fingerprint, failed_attempts, last_attempt, locked_until)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(device_fingerprint) DO UPDATE SET
                failed_attempts = excluded.failed_attempts,
                last_attempt = excluded.last_attempt,
                locked_until = excluded.locked_until
            `).bind(fingerprint, newAttempts, now.toISOString(), lockedUntil).run();
            
            return jsonResponse({ 
              success: false, 
              error: 'Invalid code',
              attempts_remaining: Math.max(0, 3 - newAttempts)
            }, 401);
          }
        } catch (error) {
          console.error('TOTP verification error:', error);
          return jsonResponse({ 
            error: 'Verification failed', 
            details: error.message 
          }, 500);
        }
      }
      
      // POST /log - Log food/gym/exercise entry
      if (url.pathname === '/log' && request.method === 'POST') {
        const authorized = await isAuthorized();
        if (!authorized) {
          const provided = getApiKey();
          return jsonResponse({ 
            error: 'Invalid API key',
            provided: provided ? provided.substring(0, 3) + '...' : 'none'
          }, 401);
        }
        
        const data = await request.json();
        console.log('Log entry payload:', JSON.stringify(data));
        // Support both old DynamoDB format (note, value) and new format (foodName, calories)
        const { date, time, type, foodName, note, calories, value, protein, exercise, weight, reps } = data;
        const userId = 1; // Single user for now
        
        const finalFoodName = foodName || note || '';
        const finalCalories = calories !== undefined ? calories : (value || 0);
        
        // Use current time if not provided
        const finalTime = time || new Date().toTimeString().split(' ')[0];
        
        // SQL is SO much cleaner than DynamoDB!
        if (type === 'FOOD') {
          await env.DB.prepare(`
            INSERT INTO food_logs (user_id, date, time, food_name, calories, protein)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(userId, date, finalTime, finalFoodName, finalCalories, protein || 0).run();
        }
        else if (type === 'GYM') {
          await env.DB.prepare(`
            INSERT INTO gym_logs (user_id, date, time)
            VALUES (?, ?, ?)
          `).bind(userId, date, finalTime).run();
        }
        else if (type === 'EXERCISE') {
          await env.DB.prepare(`
            INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(userId, date, finalTime, exercise || '', weight || 0, reps || 0).run();
        }
        else if (type === 'ACTIVE' || type === 'WEIGHT' || type === 'SLEEP') {
          // Upsert daily metric (ON CONFLICT UPDATE)
          await env.DB.prepare(`
            INSERT INTO daily_metrics (user_id, date, metric_type, value)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value
          `).bind(userId, date, type, value || 0).run();
        }
        
        return jsonResponse({ status: 'success' });
      }
      
      // GET /data - Get data for dashboard or specific date
      if (url.pathname === '/data' && request.method === 'GET') {
        const authorized = await isAuthorized();
        if (!authorized) {
          const provided = getApiKey();
          return jsonResponse({ 
            error: 'Invalid API key', 
            details: 'Auth failed',
            providedKey: provided ? provided.substring(0, 4) + '...' : 'none'
          }, 401);
        }
        
        const date = url.searchParams.get('date');
        const userId = 1;
        
        let foodLogs, gymLogs, exerciseLogs, dailyMetrics;
        
        if (date) {
          // Specific date
          [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
            env.DB.prepare('SELECT * FROM food_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
            env.DB.prepare('SELECT * FROM gym_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
            env.DB.prepare('SELECT * FROM exercise_logs WHERE user_id = ? AND date = ? ORDER BY time').bind(userId, date).all(),
            env.DB.prepare('SELECT * FROM daily_metrics WHERE user_id = ? AND date = ?').bind(userId, date).all()
          ]);
        } else {
          // All data (for dashboard history)
          [foodLogs, gymLogs, exerciseLogs, dailyMetrics] = await Promise.all([
            env.DB.prepare('SELECT * FROM food_logs WHERE user_id = ? ORDER BY date DESC, time DESC').bind(userId).all(),
            env.DB.prepare('SELECT * FROM gym_logs WHERE user_id = ? ORDER BY date DESC, time DESC').bind(userId).all(),
            env.DB.prepare('SELECT * FROM exercise_logs WHERE user_id = ? ORDER BY date DESC, time DESC').bind(userId).all(),
            env.DB.prepare('SELECT * FROM daily_metrics WHERE user_id = ? ORDER BY date DESC').bind(userId).all()
          ]);
        }
        
        // Transform to match your frontend format (PascalCase for compatibility!)
        const items = [];
        
        foodLogs.results?.forEach(log => {
          items.push({
            PK: log.date,
            SK: `FOOD#${log.time}#${log.log_id}`,
            Type: 'FOOD',
            Value: log.calories,
            Protein: log.protein,
            Date: log.date,
            Time: log.time,
            Note: log.food_name,
            logId: log.log_id
          });
        });
        
        gymLogs.results?.forEach(log => {
          items.push({
            PK: log.date,
            SK: `GYM#${log.time}#${log.log_id}`,
            Type: 'GYM',
            Date: log.date,
            Time: log.time,
            logId: log.log_id
          });
        });
        
        exerciseLogs.results?.forEach(log => {
          items.push({
            PK: log.date,
            SK: `EXERCISE#${log.time}#${log.log_id}`,
            Type: 'EXERCISE',
            Date: log.date,
            Time: log.time,
            Exercise: log.exercise_name,
            Weight: log.weight_kg,
            Reps: log.reps,
            logId: log.log_id
          });
        });
        
        dailyMetrics.results?.forEach(metric => {
          items.push({
            PK: metric.date,
            SK: `METRIC#${metric.metric_type}`,
            Type: metric.metric_type,
            Value: metric.value,
            Date: metric.date
          });
        });
        
        return jsonResponse({ 
          items, 
          baseline: 1800 // Default from original API
        });
      }
      
      // GET /meals - Get saved meals
      if (url.pathname === '/meals' && request.method === 'GET') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }
        
        const userId = 1;
        const result = await env.DB.prepare(`
          SELECT meal_name, calories, protein, portions, is_quick_food, ingredients
          FROM saved_meals 
          WHERE user_id = ? 
          ORDER BY meal_name
        `).bind(userId).all();
        
        // Transform to PascalCase for frontend compatibility
        const meals = result.results?.map(m => ({
          MealName: m.meal_name,
          Calories: m.calories,
          Protein: m.protein,
          Portions: m.portions || 1,
          isQuickFood: m.is_quick_food === 1,
          Ingredients: m.ingredients ? JSON.parse(m.ingredients) : []
        })) || [];
        
        return jsonResponse({ meals });
      }
      
      // POST /meals - Save a meal
      if (url.pathname === '/meals' && request.method === 'POST') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }
        
        const data = await request.json();
        const { name, mealName, calories, protein, portions, ingredients, isQuickFood } = data;
        const finalName = name || mealName;
        const userId = 1;
        
        const ingredientsJson = ingredients ? JSON.stringify(ingredients) : '[]';
        
        await env.DB.prepare(`
          INSERT INTO saved_meals (user_id, meal_name, calories, protein, portions, is_quick_food, ingredients)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, meal_name) DO UPDATE SET
            calories = excluded.calories,
            protein = excluded.protein,
            portions = excluded.portions,
            is_quick_food = excluded.is_quick_food,
            ingredients = excluded.ingredients
        `).bind(
          userId, 
          finalName, 
          calories || 0, 
          protein || 0, 
          portions || 1, 
          isQuickFood ? 1 : 0, 
          ingredientsJson
        ).run();
        
        return jsonResponse({ status: 'success' });
      }
      
      // DELETE /meals - Delete a saved meal
      if (url.pathname === '/meals' && request.method === 'DELETE') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }
        
        const mealName = url.searchParams.get('name');
        if (!mealName) {
          return jsonResponse({ error: 'Missing name parameter' }, 400);
        }
        
        const userId = 1;
        await env.DB.prepare('DELETE FROM saved_meals WHERE user_id = ? AND meal_name = ?')
          .bind(userId, mealName).run();
        
        return jsonResponse({ status: 'success' });
      }
      
      // DELETE /log - Delete a log entry
      if (url.pathname === '/log' && request.method === 'DELETE') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }
        
        let logId = url.searchParams.get('id');
        let type = url.searchParams.get('type');
        const pk = url.searchParams.get('pk');
        const sk = url.searchParams.get('sk');
        
        // Handle pk/sk format from original frontend
        if (pk && sk) {
          const parts = sk.split('#');
          type = parts[0];
          if (type === 'METRIC') {
             type = parts[1]; // ACTIVE, WEIGHT, etc.
          } else {
             logId = parts[parts.length - 1]; // The log_id we appended
          }
        }
        
        if (!type || (!logId && !['ACTIVE', 'WEIGHT', 'SLEEP'].includes(type))) {
          return jsonResponse({ error: 'Missing identifier parameters' }, 400);
        }
        
        const userId = 1;
        
        // Delete from appropriate table based on type
        if (type === 'FOOD') {
          await env.DB.prepare('DELETE FROM food_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
        } else if (type === 'GYM') {
          await env.DB.prepare('DELETE FROM gym_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
        } else if (type === 'EXERCISE') {
          await env.DB.prepare('DELETE FROM exercise_logs WHERE user_id = ? AND log_id = ?').bind(userId, logId).run();
        } else if (type === 'ACTIVE' || type === 'WEIGHT' || type === 'SLEEP') {
          // These are daily metrics (upserted)
          await env.DB.prepare('DELETE FROM daily_metrics WHERE user_id = ? AND date = ? AND metric_type = ?').bind(userId, pk, type).run();
        }
        
        return jsonResponse({ status: 'success' });
      }
      
      // POST /config - Save goals configuration
      if (url.pathname === '/config' && request.method === 'POST') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
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
        
        return jsonResponse({ status: 'success' });
      }
      
      // GET /config - Get goals configuration with history
      if (url.pathname === '/config' && request.method === 'GET') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
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
          });
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
        });
      }
      
      // POST /trust-device - Create trusted device token
      if (url.pathname === '/trust-device' && request.method === 'POST') {
        if (!await isAuthorized()) {
          return jsonResponse({ error: 'Invalid API key' }, 401);
        }
        
        const body = await request.json();
        const deviceFingerprint = body.deviceFingerprint;
        
        if (!deviceFingerprint) {
          return jsonResponse({ error: 'Device fingerprint required' }, 400);
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
        });
      }
      
      // GET /trust-device - Check if device is trusted
      if (url.pathname === '/trust-device' && request.method === 'GET') {
        const deviceFingerprint = url.searchParams.get('deviceFingerprint');
        const deviceToken = url.searchParams.get('deviceToken');
        
        if (!deviceFingerprint || !deviceToken) {
          return jsonResponse({ trusted: false });
        }
        
        const result = await env.DB.prepare(`
          SELECT device_token, expires_at 
          FROM device_tokens_v2 
          WHERE device_fingerprint = ?
        `).bind(deviceFingerprint).first();
        
        if (!result) {
          return jsonResponse({ trusted: false });
        }
        
        // Check token matches and hasn't expired
        const isValid = result.device_token === deviceToken && 
                       new Date(result.expires_at) > new Date();
        
        return jsonResponse({ trusted: isValid });
      }
      
      return jsonResponse({
        error: 'Not found',
        available_endpoints: [
          'POST /auth',
          'POST /verify-totp',
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
      }, 404);
      
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({
        error: error.message,
        stack: error.stack
      }, 500);
    }
  }
};
// END OF FILE MARKER

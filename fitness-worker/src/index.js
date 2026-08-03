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

  // GET /search (Unified ML-ready search)
  if (path === '/search' && method === 'GET') {
    const query = url.searchParams.get('q');
    if (!query) return jsonResponse({ products: [] });

    try {
      const userAgent = 'FitnessDash/1.1 (Windows; info@ignitegroup.services) CloudflareWorker-Proxy';

      // Helper for retrying fetches (especially for OFF which is flakey)
      async function fetchWithRetry(targetUrl, maxAttempts = 3) {
        let attempts = 0;
        let lastRes = null;
        while (attempts < maxAttempts) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(targetUrl, {
              headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
              signal: controller.signal,
              cf: { cacheTtl: 3600, cacheEverything: true }
            });
            clearTimeout(timeoutId);
            if (res.ok) return res;
            lastRes = res;
            if (res.status === 503 || res.status === 429) {
              await new Promise(r => setTimeout(r, 1000 * (attempts + 1)));
            } else {
              break;
            }
          } catch (e) {
            console.error(`Fetch error for ${targetUrl}:`, e.message);
          }
          attempts++;
        }
        return lastRes;
      }

      const usdaParams = new URLSearchParams({
        api_key: env.USDA_API_KEY || '',
        query: query,
        pageSize: '20',
        dataType: 'Foundation,SR Legacy'
      });

      // UK/US Synonym Mapping for better recall
      const SYNONYMS = {
        'soy': 'soya', 'soymilk': 'soya milk',
        'soymilks': 'soya milk', 'soyamilk': 'soya milk',
        'zucchini': 'courgette', 'eggplant': 'aubergine',
        'cilantro': 'coriander', 'rutabaga': 'swede',
        'scallion': 'spring onion', 'beet': 'beetroot'
      };

      const UK_RETAILERS = [
        'tesco', 'sainsbury', 'asda', 'aldi', 'lidl', 'marks', 'waitrose', 
        'morrison', 'm&s', 'co-op', 'everyday essentials', 'essential waitrose', 
        'finest', 'taste the difference', 'ocado', 'iceland', 'waitrose & partners'
      ];

      // Normalize query for internal use and OFF search.
      const offQueryOriginal = query.toLowerCase().trim().replace(/\s+/g, ' ');
      let offQuery = offQueryOriginal;

      // Detect UK brands from the original query for branded search behavior.
      const detectedBrand = UK_RETAILERS.find(brand => {
        const regex = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(offQueryOriginal);
      });

      // For non-branded searches, normalize US/UK synonyms to improve generic food recall.
      if (!detectedBrand) {
        if (offQuery.includes('soymilk')) {
          offQuery = offQuery.replace(/soymilk/g, 'soya milk');
        }
        Object.entries(SYNONYMS).forEach(([us, uk]) => {
          const regex = new RegExp(`\\b${us}\\b`, 'g');
          if (regex.test(offQuery)) {
            offQuery = offQuery.replace(regex, uk);
          }
        });
      }

      const offParamsUk = new URLSearchParams({
        search_terms: offQuery,
        page_size: '50',
        sort_by: 'unique_scans_n',
        lc: 'en',
        cc: 'uk',
        action: 'process',
        json: '1'
      });

      // Global OFF fallback (no country pin) improves recall for niche branded products.
      const offParamsGlobal = new URLSearchParams({
        search_terms: offQueryOriginal,
        page_size: '40',
        sort_by: 'unique_scans_n',
        lc: 'en',
        action: 'process',
        json: '1'
      });

      let offUrl = `https://world.openfoodfacts.org/cgi/search.pl?${offParamsUk.toString()}`;
      let offGlobalUrl = `https://world.openfoodfacts.org/cgi/search.pl?${offParamsGlobal.toString()}`;
      let brandSearchUrl = null;

      if (detectedBrand) {
        // Create a relaxed search: remove brand from terms and use it as a brand filter
        const relaxedTerms = offQueryOriginal.replace(detectedBrand, '').trim().replace(/\s+/g, ' ');
        if (relaxedTerms) {
          const brandParams = new URLSearchParams({
            search_terms: relaxedTerms,
            tagtype_0: 'brands',
            tag_contains_0: 'contains',
            tag_0: detectedBrand,
            page_size: '50',
            sort_by: 'unique_scans_n',
            lc: 'en',
            cc: 'uk',
            action: 'process',
            json: '1'
          });
          brandSearchUrl = `https://world.openfoodfacts.org/cgi/search.pl?${brandParams.toString()}`;
        }
      }

      const usdaUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?${usdaParams.toString()}`;

      // Flexible D1 search: split query into words to allow broad matching
      // We use both the original words and the normalized ones for CoFID search
      const qWordsRaw = offQuery.split(/[^a-z0-9]/).filter(x => x.length > 1);
      const searchWords = qWordsRaw.length > 0 ? qWordsRaw : offQuery.split(/\s+/).filter(x => x);
      
      // Use placeholders that won't match everything if unused
      const w1 = searchWords[0] ? `%${searchWords[0]}%` : '%UNUSED_TOKEN%';
      const w2 = searchWords[1] ? `%${searchWords[1]}%` : '%UNUSED_TOKEN%';
      const w3 = searchWords[2] ? `%${searchWords[2]}%` : '%UNUSED_TOKEN%';

      // Parallel fetch + D1 checks (History, Meals, CoFID, Weights)
      const [usdaRes, offResRaw, offGlobalResRaw, brandOffResRaw, cofidResults, historyResults, mealsResults, weightsRows] = await Promise.all([
        fetchWithRetry(usdaUrl, 2),
        fetchWithRetry(offUrl, 3),
        fetchWithRetry(offGlobalUrl, 2),
        brandSearchUrl ? fetchWithRetry(brandSearchUrl, 3) : Promise.resolve(null),
        env.DB.prepare(`
          SELECT *, 
          ( (CASE WHEN name LIKE ? OR search_keywords LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN name LIKE ? OR search_keywords LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN name LIKE ? OR search_keywords LIKE ? THEN 1 ELSE 0 END) ) as mc
          FROM cofid_data 
          WHERE (name LIKE ? OR search_keywords LIKE ? OR name LIKE ? OR search_keywords LIKE ? OR name LIKE ? OR search_keywords LIKE ?)
          ORDER BY mc DESC, name ASC LIMIT 200
        `).bind(w1, w1, w2, w2, w3, w3, w1, w1, w2, w2, w3, w3).all(),
        env.DB.prepare(`
          SELECT food_name, calories, protein, carbs, fat, nutrients_json,
          ( (CASE WHEN food_name LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN food_name LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN food_name LIKE ? THEN 1 ELSE 0 END) ) as mc
          FROM food_logs 
          WHERE user_id = ? AND (food_name LIKE ? OR food_name LIKE ? OR food_name LIKE ?)
          GROUP BY food_name ORDER BY mc DESC, date DESC LIMIT 100
        `).bind(w1, w2, w3, userId, w1, w2, w3).all(),
        env.DB.prepare(`
             SELECT m.meal_name, SUM(i.calories) as total_cals, SUM(i.protein) as total_pro,
               SUM(i.carbs) as total_carbs, SUM(i.fat) as total_fat,
          ( (CASE WHEN m.meal_name LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN m.meal_name LIKE ? THEN 1 ELSE 0 END) +
            (CASE WHEN m.meal_name LIKE ? THEN 1 ELSE 0 END) ) as mc
          FROM meals m JOIN ingredients i ON m.meal_id = i.meal_id 
          WHERE m.user_id = ? AND (m.meal_name LIKE ? OR m.meal_name LIKE ? OR m.meal_name LIKE ?)
          GROUP BY m.meal_name ORDER BY mc DESC LIMIT 50
        `).bind(w1, w2, w3, userId, w1, w2, w3).all(),
        env.DB.prepare('SELECT * FROM search_weights').all()
      ]);

      const weights = {
        exact_match: 45000,
        starts_with: 18000,
        all_words_bonus: 25000,
        cofid_bonus: 24000,
        generic_bonus: 10000,
        uk_brand_bonus: 20000,
        history_bonus: 50000,
        meal_bonus: 40000,
        brand_query_match_bonus: 45000,
        generic_when_brand_penalty: 18000,
        off_brand_miss_penalty: 12000,
        shortness_bonus: 4000
      };
      weightsRows.results?.forEach(r => weights[r.feature_name] = r.weight_value);

      const normalizedResults = [];

      // 1. CoFID Adapter
      cofidResults.results?.forEach(f => {
        normalizedResults.push({
          name: f.name, brand: f.brand || 'Generic (UK CoFID)', cals: f.calories,
          pro: f.protein, carbs: f.carbs, fat: f.fat, source: 'CoFID',
          nutrients: { 
            fiber: f.fiber, sugar: f.sugar,
            sodium: f.sodium, potassium: f.potassium, calcium: f.calcium,
            magnesium: f.magnesium, iron: f.iron, zinc: f.zinc,
            'vitamin-a': f.vitamin_a, 'vitamin-c': f.vitamin_c, 'vitamin-d': f.vitamin_d,
            'vitamin-e': f.vitamin_e, 'vitamin-k': f.vitamin_k,
            source: 'UK CoFID'
          }
        });
      });

      // 2. History Adapter
      historyResults.results?.forEach(h => {
        const nutrients = h.nutrients_json ? JSON.parse(h.nutrients_json) : null;
        if (nutrients) {
          delete nutrients.carbs;
          delete nutrients.fat;
        }
        normalizedResults.push({
          name: h.food_name, brand: 'Logged Before', cals: h.calories,
          pro: h.protein, carbs: h.carbs, fat: h.fat, source: 'History',
          nutrients
        });
      });

      // 3. Saved Meals Adapter
      mealsResults.results?.forEach(m => {
        normalizedResults.push({
          name: m.meal_name, brand: 'Your Meal', cals: m.total_cals,
          pro: m.total_pro, carbs: m.total_carbs, fat: m.total_fat, source: 'Saved Meal',
          nutrients: null // Meals are complex aggregates
        });
      });

      // 4. USDA Adapter
      if (usdaRes && usdaRes.ok) {
        const usdaData = await usdaRes.json();
        (usdaData.foods || []).forEach(f => {
          const findNutrient = (id) => f.foodNutrients?.find(n => n.nutrientId === id)?.value || 0;
          normalizedResults.push({
            name: f.description, brand: 'Generic (USDA)', cals: findNutrient(1008),
            pro: findNutrient(1003), carbs: findNutrient(1005), fat: findNutrient(1004), source: 'USDA',
            nutrients: { 
              fiber: findNutrient(1079), sugar: findNutrient(2000) || findNutrient(1063), // 2000 is often Sugars, total
              sodium: findNutrient(1093), potassium: findNutrient(1092), calcium: findNutrient(1087),
              magnesium: findNutrient(1090), iron: findNutrient(1089), zinc: findNutrient(1095),
              'vitamin-a': findNutrient(1106), 'vitamin-c': findNutrient(1162), 
              'vitamin-d': findNutrient(1114) || findNutrient(1110), 'vitamin-e': findNutrient(1109), 
              'vitamin-k': findNutrient(1185),
              source: 'USDA Foundation' 
            }
          });
        });
      }

      // 5. OFF Adapter
      const processOffResults = (offData) => {
        (offData.products || []).filter(p => p.product_name).forEach(p => {
          const n = p.nutriments || {};
          const kcalRaw = Number(n['energy-kcal_100g'] || n['energy-kcal'] || 0);
          const kjRaw = Number(n['energy_100g'] || n['energy-kj_100g'] || n['energy-kj'] || 0);
          const calories = kcalRaw > 0 ? kcalRaw : (kjRaw > 0 ? (kjRaw / 4.184) : 0);
          normalizedResults.push({
            name: p.product_name, brand: p.brands || 'Store Brand', cals: Math.round(calories || 0),
            pro: Number(n.proteins_100g || 0), carbs: Number(n.carbohydrates_100g || 0), fat: Number(n.fat_100g || 0), source: 'OFF',
            nutrients: { 
              sugar: n.sugars_100g || 0, fiber: n.fiber_100g || 0,
              sodium: (n.sodium_100g || 0) * 1000, 
              potassium: (n.potassium_100g || 0) * 1000, 
              calcium: (n.calcium_100g || 0) * 1000,
              magnesium: (n.magnesium_100g || 0) * 1000, 
              iron: (n.iron_100g || 0) * 1000, 
              zinc: (n.zinc_100g || 0) * 1000,
              'vitamin-a': (n['vitamin-a_100g'] || 0) * 1000000, 
              'vitamin-c': (n['vitamin-c_100g'] || 0) * 1000, 
              'vitamin-d': (n['vitamin-d_100g'] || 0) * 1000000, 
              'vitamin-e': (n['vitamin-e_100g'] || 0) * 1000, 
              'vitamin-k': (n['vitamin-k_100g'] || 0) * 1000000,
              source: 'Open Food Facts' 
            }
          });
        });
      };

      if (offResRaw && offResRaw.ok) {
        processOffResults(await offResRaw.json());
      }
      if (offGlobalResRaw && offGlobalResRaw.ok) {
        processOffResults(await offGlobalResRaw.json());
      }
      if (brandOffResRaw && brandOffResRaw.ok) {
        processOffResults(await brandOffResRaw.json());
      }

      // Scoring & Sorting (Top 10 per source)
      function calculateProductScore(p, q, w) {
        if (!p.name) return 0;
        let score = 0;
        const n = p.name.toLowerCase();
        const b = (p.brand || '').toLowerCase();
        const qClean = q.toLowerCase().trim().replace(/\s+/g, ' ');
        // Remove punctuation from query words for comparison
        const qWords = qClean.split(/[^a-z0-9]/).filter(x => x.length > 0);
        const nWords = n.split(/[^a-z0-9]/).filter(x => x.length > 0);
        const brandSpecificQuery = UK_RETAILERS.some(r => qClean.includes(r));
        const explicitBrandMatch = UK_RETAILERS.some(r => qClean.includes(r) && (b.includes(r) || n.includes(r)));
        
        let matchCount = 0;
        let allWordsMatch = true;
        qWords.forEach(qw => { 
          // Match if it's a whole word or significant prefix
          let isMatch = nWords.some(nw => nw === qw || (nw.length > 3 && nw.startsWith(qw)));
          
          // Synonym support (e.g., soy matches soya)
          if (!isMatch) {
            const syn = SYNONYMS[qw] || Object.keys(SYNONYMS).find(k => SYNONYMS[k] === qw);
            if (syn) {
              const synWords = syn.split(/\s+/);
              // Match if ANY of the synonym words are found as a whole word or prefix
              isMatch = synWords.some(sw => sw.length > 3 && nWords.some(nw => nw === sw || nw.startsWith(sw)));
            }
          }

          if (isMatch || b.includes(qw)) {
            matchCount++;
          } else {
            allWordsMatch = false;
          }
        });

        if (n === qClean) score += (w.exact_match || 50000);
        if (n.startsWith(qClean)) score += (w.starts_with || 20000);
        if (allWordsMatch && qWords.length > 1) score += (w.all_words_bonus || 30000);
        if (explicitBrandMatch) score += (w.brand_query_match_bonus || 45000);
        
        if (p.source === 'CoFID') score += (w.cofid_bonus || 40000);
        if (p.source === 'History') score += (w.history_bonus || 60000);
        if (p.source === 'Saved Meal') score += (w.meal_bonus || 50000);
        if (p.source === 'USDA') score += (w.generic_bonus || 10000);
        
        if (UK_RETAILERS.some(r => b.includes(r) || n.includes(r))) score += (w.uk_brand_bonus || 80000);

        // Word match density bonus
        score += (matchCount * 5000);
        if (qWords.length > 0) {
            const coverage = matchCount / qWords.length;
            score += (coverage * 10000);
        }

        // If user asked for a specific retailer/brand, generic sources should rank lower.
        if (brandSpecificQuery && (p.source === 'USDA' || p.source === 'CoFID')) {
          score -= (w.generic_when_brand_penalty || 18000);
        }
        if (brandSpecificQuery && p.source === 'OFF' && !explicitBrandMatch) {
          score -= (w.off_brand_miss_penalty || 12000);
        }
        
        score += (100 / (n.length + 1)) * (w.shortness_bonus || 2000);

        // If at least one word doesn't match and the query is specific, lower the score
        if (matchCount === 0) score = 0;
        return score;
      }

      // Dedupe merged candidates before scoring.
      const dedupedResults = [];
      const seenKeys = new Set();
      normalizedResults.forEach(p => {
        const key = `${(p.name || '').toLowerCase()}|${(p.brand || '').toLowerCase()}|${p.source}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          dedupedResults.push(p);
        }
      });

      const scored = dedupedResults
        .map(p => ({ ...p, score: calculateProductScore(p, query, weights) }))
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score);

      // Global ranking with source caps preserves variety without forcing weak results.
      const sourceCaps = { History: 8, 'Saved Meal': 6, CoFID: 12, USDA: 12, OFF: 20 };
      const sourceCounts = {};
      const finalProducts = [];
      const maxResults = 40;

      for (const item of scored) {
        const cap = sourceCaps[item.source] || 10;
        const used = sourceCounts[item.source] || 0;
        if (used >= cap) continue;
        finalProducts.push(item);
        sourceCounts[item.source] = used + 1;
        if (finalProducts.length >= maxResults) break;
      }

      const rankedProducts = finalProducts.map((p, idx) => ({ ...p, rank: idx + 1 }));

      return jsonResponse({
        products: rankedProducts,
        weights_version: 'v2.global-capped-ranked'
      });

    } catch (e) {
      console.error('Unified Search Error:', e);
      return jsonResponse({ error: 'Search failed', details: e.message }, 500);
    }
  }

  // POST /feedback (Record user clicks for ML training)
  if (path === '/feedback' && method === 'POST') {
    const { query, resultName, resultSource, rank } = await request.json();
    
    await env.DB.prepare(`
      INSERT INTO search_feedback (query, result_name, result_source, clicked_rank)
      VALUES (?, ?, ?, ?)
    `).bind(query, resultName, resultSource, rank).run();

    // Check if we reached 20 new feedbacks to trigger a "training" tweak
    const count = await env.DB.prepare('SELECT COUNT(*) as total FROM search_feedback').first();
    if (count.total % 20 === 0 && count.total > 0) {
      // Trigger background weight adjustment logic
      // In a real scenario, this would be more complex, but here we'll do a simple nudge
      console.log('Triggering "training" tweak after 20 feedbacks...');
      
      // If users click results at lower ranks (> 5), we slightly increase "starts_with" or "generic_bonus"
      const avgRank = await env.DB.prepare('SELECT AVG(clicked_rank) as avg_r FROM search_feedback').first();
      
      if (avgRank.avg_r > 3) {
        // Results aren't at the top, boost the generic and exact match weights
        await env.DB.prepare("UPDATE search_weights SET weight_value = weight_value * 1.05 WHERE feature_name IN ('generic_bonus', 'cofid_bonus', 'exact_match')").run();
      }
    }

    return jsonResponse({ success: true, message: 'Feedback recorded' });
  }

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

    const { date, time, type, foodName, note, calories, value, protein, carbs, fat, exercise, weight, reps, amount, amountUnit, nutrients } = data;
    if (!date) return jsonResponse({ error: 'Date is required' }, 400);

    const finalFoodName = foodName || note || '';
    const finalCalories = calories !== undefined ? calories : (value || 0);
    let nutrientsJson = null;
    if (nutrients) {
      const micronutrients = { ...nutrients };
      delete micronutrients.carbs;
      delete micronutrients.fat;
      nutrientsJson = JSON.stringify(micronutrients);
    }
    
    // Ensure time is never null/empty for the database
    let finalTime = time;
    if (!finalTime || finalTime.trim() === '') {
      finalTime = new Date().toISOString().split('T')[1].split('.')[0];
    }

    try {
      if (type === 'FOOD') {
        await env.DB.prepare(`
          INSERT INTO food_logs (user_id, date, time, food_name, calories, protein, carbs, fat, amount, amount_unit, nutrients_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(userId, date, finalTime, finalFoodName, Number(finalCalories), Number(protein || 0), Number(carbs || 0), Number(fat || 0), amount || null, amountUnit || null, nutrientsJson).run();
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
      Carbs: l.carbs,
      Fat: l.fat,
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
      const totalCarbs = mealIngredients.reduce((sum, i) => sum + (i.carbs || 0), 0);
      const totalFat = mealIngredients.reduce((sum, i) => sum + (i.fat || 0), 0);

      return {
        mealId: m.meal_id,
        MealName: m.meal_name,
        Calories: totalCalories,
        Protein: totalProtein,
        Carbs: totalCarbs,
        Fat: totalFat,
        Portions: m.portions || 1,
        isQuickFood: m.is_quick_food === 1,
        Ingredients: mealIngredients.map(i => ({
          desc: i.name,
          qty: i.amount,
          unit: i.amount_units,
          cals: i.calories,
          pro: i.protein,
          carbs: i.carbs,
          fat: i.fat,
          nutrients: (() => {
            if (!i.nutrients_json) return null;
            const nutrients = JSON.parse(i.nutrients_json);
            delete nutrients.carbs;
            delete nutrients.fat;
            return nutrients;
          })()
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
            INSERT INTO ingredients (meal_id, name, amount, amount_units, calories, protein, carbs, fat, nutrients_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mealId, 
            ing.desc || finalName, 
            Number(ing.qty || 0), 
            ing.unit || 'g', 
            Number(ing.cals || 0), 
            Number(ing.pro || 0),
            Number(ing.carbs || 0),
            Number(ing.fat || 0),
            ing.nutrients ? JSON.stringify(Object.fromEntries(
              Object.entries(ing.nutrients).filter(([key]) => key !== 'carbs' && key !== 'fat')
            )) : null
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


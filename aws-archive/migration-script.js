import fs from 'fs';
import { execSync } from 'child_process';

// Standard DynamoDB Export Files
const LOGS_FILE = 'dynamodb_logs.json';
const MEALS_FILE = 'dynamodb_meals.json';
const BATCH_SIZE = 50;

function escapeSql(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
}

function migrate() {
    console.log('🚀 Loading fresh DynamoDB exports...');
    
    if (!fs.existsSync(LOGS_FILE) || !fs.existsSync(MEALS_FILE)) {
        console.error('❌ Missing source files: dynamodb_logs.json or dynamodb_meals.json');
        process.exit(1);
    }

    let logsStr = fs.readFileSync(LOGS_FILE, 'utf8');
    if (logsStr.startsWith('\uFFFD')) {
        logsStr = fs.readFileSync(LOGS_FILE, 'utf16le');
    }
    const logsJSON = JSON.parse(logsStr.replace(/^\uFEFF/, ''));
    const logs = logsJSON.Items || [];
    
    let mealsStr = fs.readFileSync(MEALS_FILE, 'utf8');
    if (mealsStr.startsWith('\uFFFD')) {
        mealsStr = fs.readFileSync(MEALS_FILE, 'utf16le');
    }
    const mealsJSON = JSON.parse(mealsStr.replace(/^\uFEFF/, ''));
    const meals = mealsJSON.Items || [];

    const sqlStatements = [];
    const userId = 1;

    // STEP 1: CLEAN START
    console.log('🧹 Clearing existing data to prevent corruption...');
    sqlStatements.push("DELETE FROM food_logs;");
    sqlStatements.push("DELETE FROM gym_logs;");
    sqlStatements.push("DELETE FROM exercise_logs;");
    sqlStatements.push("DELETE FROM daily_metrics;");
    sqlStatements.push("DELETE FROM saved_meals;");

    // STEP 2: PROCESS LOGS
    console.log(`📝 Processing ${logs.length} log items...`);
    logs.forEach(item => {
        const pk = item.PK?.S || item.PK; // Date in YYYY-MM-DD
        const type = item.Type?.S || item.Type;
        const timestamp = item.Timestamp?.S || '00:00:00';

        if (type === 'FOOD') {
            const name = item.Note?.S || '';
            const cal = parseFloat(item.Value?.N || 0);
            const pro = parseFloat(item.Protein?.N || 0);
            sqlStatements.push(`INSERT INTO food_logs (user_id, date, time, food_name, calories, protein) VALUES (${userId}, '${pk}', '${timestamp}', '${escapeSql(name)}', ${cal}, ${pro});`);
        } else if (type === 'GYM') {
            sqlStatements.push(`INSERT INTO gym_logs (user_id, date, time) VALUES (${userId}, '${pk}', '${timestamp}');`);
        } else if (type === 'EXERCISE') {
            const name = item.Exercise?.S || '';
            const weight = parseFloat(item.Weight?.N || 0);
            const reps = parseInt(item.Reps?.N || 0);
            sqlStatements.push(`INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps) VALUES (${userId}, '${pk}', '${timestamp}', '${escapeSql(name)}', ${weight}, ${reps});`);
        } else if (['ACTIVE', 'WEIGHT', 'SLEEP'].includes(type)) {
            const val = parseFloat(item.Value?.N || 0);
            sqlStatements.push(`INSERT INTO daily_metrics (user_id, date, metric_type, value) VALUES (${userId}, '${pk}', '${type}', ${val}) ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value;`);
        }
    });

    // STEP 3: PROCESS MEALS
    console.log(`🍱 Processing ${meals.length} saved meals...`);
    meals.forEach(meal => {
        const name = meal.MealName?.S || '';
        const cal = parseInt(meal.Calories?.N || 0);
        const pro = parseInt(meal.Protein?.N || 0);
        const portions = parseInt(meal.Portions?.N || 1);
        const isQuick = meal.isQuickFood?.BOOL ? 1 : 0;
        
        // Handle ingredients if present
        let ingredientsJson = '[]';
        if (meal.Ingredients?.L) {
            const ingredients = meal.Ingredients.L.map(ing => {
                const m = ing.M || {};
                return {
                    desc: m.desc?.S || '',
                    qty: m.qty?.S || '',
                    cals: parseInt(m.cals?.N || 0)
                };
            });
            ingredientsJson = JSON.stringify(ingredients);
        }

        if (name) {
            sqlStatements.push(`INSERT INTO saved_meals (user_id, meal_name, calories, protein, portions, is_quick_food, ingredients) VALUES (${userId}, '${escapeSql(name)}', ${cal}, ${pro}, ${portions}, ${isQuick}, '${escapeSql(ingredientsJson)}') ON CONFLICT(user_id, meal_name) DO UPDATE SET calories = excluded.calories, protein = excluded.protein, portions = excluded.portions, is_quick_food = excluded.is_quick_food, ingredients = excluded.ingredients;`);
        }
    });

    console.log(`📦 Prepared ${sqlStatements.length} SQL statements.`);
    console.log(`📡 Executing in batches of ${BATCH_SIZE} on Cloudflare...`);

    for (let i = 0; i < sqlStatements.length; i += BATCH_SIZE) {
        const batch = sqlStatements.slice(i, i + BATCH_SIZE);
        fs.writeFileSync('migration_temp.sql', batch.join('\n'));
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(sqlStatements.length / BATCH_SIZE);
        console.log(`🚀 Sending batch ${batchNum}/${totalBatches}...`);
        
        try {
            execSync('npx wrangler d1 execute fitness-tracker-test --file=migration_temp.sql --remote', { stdio: 'inherit' });
        } catch (err) {
            console.error(`❌ Batch ${batchNum} failed. Check migration_temp.sql for syntax errors.`);
            process.exit(1);
        }
    }

    if (fs.existsSync('migration_temp.sql')) fs.unlinkSync('migration_temp.sql');
    console.log('\n✨ MIGRATION SUCCESSFUL! All data is now live on D1.');
}

migrate();

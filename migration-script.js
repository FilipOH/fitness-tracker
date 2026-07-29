// DynamoDB to D1 Migration Script
// Run this to transform your existing DynamoDB data to SQL format

import * as fs from 'fs';
import { createClient } from '@libsql/client'; // D1 client for local/remote

// 1. Export your DynamoDB data first:
// aws dynamodb scan --table-name CalorieTrackerTable --region eu-west-2 > dynamodb_export.json

async function migrateDynamoToD1() {
  // Connect to D1 (local for testing, or remote URL)
  const db = createClient({
    url: 'file:local.db', // Or your D1 remote URL
  });
  
  // Load DynamoDB export
  const dynamoData = JSON.parse(fs.readFileSync('dynamodb_export.json', 'utf8'));
  const items = dynamoData.Items || dynamoData; // Handle both scan output formats
  
  console.log(`Found ${items.length} items in DynamoDB export`);
  
  const userId = 1; // Assuming single user
  let stats = {
    food: 0,
    gym: 0,
    exercise: 0,
    active: 0,
    weight: 0,
    sleep: 0,
    errors: 0
  };
  
  for (const item of items) {
    try {
      // Parse DynamoDB item structure
      const date = item.date?.S || item.date; // Handle both DynamoDB JSON and regular JSON
      const sk = item.sk?.S || item.sk;
      
      // Parse SK pattern: TYPE#time#uuid or TYPE#DAILY
      const [type, timeOrDaily, uuid] = sk.split('#');
      
      if (type === 'FOOD') {
        // Insert into food_logs table
        await db.execute({
          sql: `INSERT INTO food_logs (user_id, date, time, food_name, calories, protein) 
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            date,
            timeOrDaily, // time component
            item.foodName?.S || item.foodName || '',
            parseInt(item.calories?.N || item.calories || 0),
            parseInt(item.protein?.N || item.protein || 0)
          ]
        });
        stats.food++;
      }
      else if (type === 'GYM') {
        await db.execute({
          sql: `INSERT INTO gym_logs (user_id, date, time) VALUES (?, ?, ?)`,
          args: [userId, date, timeOrDaily]
        });
        stats.gym++;
      }
      else if (type === 'EXERCISE') {
        await db.execute({
          sql: `INSERT INTO exercise_logs (user_id, date, time, exercise_name, weight_kg, reps) 
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            date,
            timeOrDaily,
            item.exercise?.S || item.exercise || '',
            parseFloat(item.weight?.N || item.weight || 0),
            parseInt(item.reps?.N || item.reps || 0)
          ]
        });
        stats.exercise++;
      }
      else if (type === 'ACTIVE') {
        await db.execute({
          sql: `INSERT INTO daily_metrics (user_id, date, metric_type, value) 
                VALUES (?, ?, 'ACTIVE', ?)
                ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value`,
          args: [
            userId,
            date,
            parseFloat(item.value?.N || item.value || 0)
          ]
        });
        stats.active++;
      }
      else if (type === 'WEIGHT') {
        await db.execute({
          sql: `INSERT INTO daily_metrics (user_id, date, metric_type, value) 
                VALUES (?, ?, 'WEIGHT', ?)
                ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value`,
          args: [
            userId,
            date,
            parseFloat(item.value?.N || item.value || 0)
          ]
        });
        stats.weight++;
      }
      else if (type === 'SLEEP') {
        await db.execute({
          sql: `INSERT INTO daily_metrics (user_id, date, metric_type, value) 
                VALUES (?, ?, 'SLEEP', ?)
                ON CONFLICT(user_id, date, metric_type) DO UPDATE SET value = excluded.value`,
          args: [
            userId,
            date,
            parseFloat(item.value?.N || item.value || 0)
          ]
        });
        stats.sleep++;
      }
      
    } catch (error) {
      console.error(`Error migrating item:`, item, error);
      stats.errors++;
    }
  }
  
  console.log('\n✅ Migration Complete!');
  console.log('-------------------');
  console.log(`Food logs:     ${stats.food}`);
  console.log(`Gym logs:      ${stats.gym}`);
  console.log(`Exercise logs: ${stats.exercise}`);
  console.log(`Active logs:   ${stats.active}`);
  console.log(`Weight logs:   ${stats.weight}`);
  console.log(`Sleep logs:    ${stats.sleep}`);
  console.log(`Errors:        ${stats.errors}`);
  console.log('-------------------');
  console.log(`Total:         ${stats.food + stats.gym + stats.exercise + stats.active + stats.weight + stats.sleep}`);
  
  // Validation queries
  console.log('\n📊 Validation Queries:');
  
  const totalFood = await db.execute('SELECT COUNT(*) as count FROM food_logs');
  console.log(`Food logs in DB: ${totalFood.rows[0].count}`);
  
  const totalGym = await db.execute('SELECT COUNT(*) as count FROM gym_logs');
  console.log(`Gym logs in DB: ${totalGym.rows[0].count}`);
  
  const totalExercise = await db.execute('SELECT COUNT(*) as count FROM exercise_logs');
  console.log(`Exercise logs in DB: ${totalExercise.rows[0].count}`);
  
  const totalMetrics = await db.execute('SELECT COUNT(*) as count FROM daily_metrics');
  console.log(`Daily metrics in DB: ${totalMetrics.rows[0].count}`);
  
  // Sample data check
  console.log('\n🔍 Sample Food Logs:');
  const sampleFood = await db.execute({
    sql: 'SELECT date, time, food_name, calories, protein FROM food_logs ORDER BY date DESC, time DESC LIMIT 5'
  });
  console.table(sampleFood.rows);
}

// Saved Meals Migration
async function migrateSavedMeals() {
  // aws dynamodb scan --table-name SavedMealsTable --region eu-west-2 > saved_meals_export.json
  
  const db = createClient({
    url: 'file:local.db',
  });
  
  const mealsData = JSON.parse(fs.readFileSync('saved_meals_export.json', 'utf8'));
  const meals = mealsData.Items || mealsData;
  
  console.log(`\n📦 Migrating ${meals.length} saved meals...`);
  
  const userId = 1;
  let count = 0;
  
  for (const meal of meals) {
    try {
      await db.execute({
        sql: `INSERT INTO saved_meals (user_id, meal_name, calories, protein) 
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, meal_name) DO UPDATE SET 
                calories = excluded.calories, 
                protein = excluded.protein`,
        args: [
          userId,
          meal.MealName?.S || meal.MealName || '',
          parseInt(meal.Calories?.N || meal.Calories || 0),
          parseInt(meal.Protein?.N || meal.Protein || 0)
        ]
      });
      count++;
    } catch (error) {
      console.error(`Error migrating meal:`, meal, error);
    }
  }
  
  console.log(`✅ Migrated ${count} saved meals`);
  
  // Validation
  const sampleMeals = await db.execute({
    sql: 'SELECT meal_name, calories, protein FROM saved_meals ORDER BY meal_name LIMIT 10'
  });
  console.log('\n🔍 Sample Saved Meals:');
  console.table(sampleMeals.rows);
}

// Run migration
console.log('🚀 Starting DynamoDB → D1 Migration...\n');

migrateDynamoToD1()
  .then(() => migrateSavedMeals())
  .then(() => {
    console.log('\n✅ All migrations complete!');
    console.log('\n📝 Next steps:');
    console.log('1. Review the migrated data above');
    console.log('2. Run test queries to validate data integrity');
    console.log('3. Deploy to Cloudflare D1: wrangler d1 execute fitness-tracker-db --file=local.db');
    console.log('4. Test with Worker locally: wrangler dev');
    console.log('5. Deploy Worker: wrangler deploy');
  })
  .catch(error => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });

// Example test queries to run after migration
const testQueries = `
-- Total calories by date (last 7 days)
SELECT 
  date,
  SUM(calories) as total_calories,
  SUM(protein) as total_protein,
  COUNT(*) as food_entries
FROM food_logs
WHERE date >= date('now', '-7 days')
GROUP BY date
ORDER BY date DESC;

-- Exercise PRs (personal records)
SELECT 
  exercise_name,
  MAX(weight_kg) as max_weight,
  MAX(reps) as max_reps,
  date as pr_date
FROM exercise_logs
GROUP BY exercise_name
ORDER BY exercise_name;

-- Gym attendance rate (last 30 days)
SELECT 
  COUNT(DISTINCT date) as gym_days,
  30 as total_days,
  ROUND(COUNT(DISTINCT date) * 100.0 / 30, 1) as attendance_rate
FROM gym_logs
WHERE date >= date('now', '-30 days');

-- Weight trend (last 14 days)
SELECT 
  date,
  value as weight_kg
FROM daily_metrics
WHERE metric_type = 'WEIGHT'
  AND date >= date('now', '-14 days')
ORDER BY date DESC;

-- Most logged foods (top 10)
SELECT 
  food_name,
  COUNT(*) as times_logged,
  AVG(calories) as avg_calories,
  AVG(protein) as avg_protein
FROM food_logs
GROUP BY food_name
ORDER BY times_logged DESC
LIMIT 10;
`;

// Save test queries to file
fs.writeFileSync('test-queries.sql', testQueries);
console.log('\n💾 Saved test queries to test-queries.sql');

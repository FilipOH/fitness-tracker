-- Cloudflare D1 Schema Design
-- Much cleaner than DynamoDB's PK/SK pattern!

-- Users table for authentication
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  totp_secret TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device trust tokens
CREATE TABLE device_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_info TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Food logs (replaces FOOD#time#uuid pattern)
CREATE TABLE food_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date DATE NOT NULL,
  time TIME NOT NULL,
  food_name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  protein INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Gym sessions (replaces GYM#time#uuid pattern)
CREATE TABLE gym_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date DATE NOT NULL,
  time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Exercise PRs (replaces EXERCISE#time#uuid pattern)
CREATE TABLE exercise_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date DATE NOT NULL,
  time TIME NOT NULL,
  exercise_name TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  reps INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Daily metrics (replaces ACTIVE/WEIGHT/SLEEP#DAILY pattern)
CREATE TABLE daily_metrics (
  metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date DATE NOT NULL,
  metric_type TEXT NOT NULL CHECK(metric_type IN ('ACTIVE', 'WEIGHT', 'SLEEP')),
  value REAL NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, date, metric_type) -- Only one value per day per metric
);

-- Saved meals (replaces SavedMealsTable)
CREATE TABLE saved_meals (
  meal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  meal_name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  protein INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, meal_name) -- Prevent duplicate meal names per user
);

-- Indexes for fast queries
CREATE INDEX idx_food_logs_user_date ON food_logs(user_id, date DESC);
CREATE INDEX idx_gym_logs_user_date ON gym_logs(user_id, date DESC);
CREATE INDEX idx_exercise_logs_user_exercise ON exercise_logs(user_id, exercise_name, date DESC);
CREATE INDEX idx_daily_metrics_user_date ON daily_metrics(user_id, date DESC);
CREATE INDEX idx_device_tokens_expires ON device_tokens(expires_at);

-- Example queries that are now MUCH easier:

-- Get all data for a specific date (replaces complex DynamoDB query)
-- SELECT * FROM food_logs WHERE user_id = ? AND date = ? ORDER BY time;

-- Get total calories for a week (impossible efficiently in current DynamoDB)
-- SELECT date, SUM(calories) as total_calories 
-- FROM food_logs 
-- WHERE user_id = ? AND date BETWEEN ? AND ? 
-- GROUP BY date;

-- Get all PRs for a specific exercise across all time
-- SELECT * FROM exercise_logs 
-- WHERE user_id = ? AND exercise_name = ? 
-- ORDER BY weight_kg DESC, reps DESC;

-- Get avg daily calories for last 30 days
-- SELECT AVG(daily_total) as avg_calories
-- FROM (
--   SELECT date, SUM(calories) as daily_total
--   FROM food_logs
--   WHERE user_id = ? AND date >= date('now', '-30 days')
--   GROUP BY date
-- );

-- Multi-table join for comprehensive daily view
-- SELECT 
--   f.date,
--   COUNT(DISTINCT f.log_id) as food_entries,
--   SUM(f.calories) as total_calories,
--   SUM(f.protein) as total_protein,
--   COUNT(DISTINCT g.log_id) as gym_sessions,
--   dm.value as weight
-- FROM food_logs f
-- LEFT JOIN gym_logs g ON f.user_id = g.user_id AND f.date = g.date
-- LEFT JOIN daily_metrics dm ON f.user_id = dm.user_id AND f.date = dm.date AND dm.metric_type = 'WEIGHT'
-- WHERE f.user_id = ? AND f.date >= ?
-- GROUP BY f.date;

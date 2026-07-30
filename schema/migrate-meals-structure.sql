-- Migration: Total Normalization
-- Remove redundant columns from meals and treat Quick Foods as 1-ingredient meals

DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS meals;

CREATE TABLE meals (
  meal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  meal_name TEXT NOT NULL,
  is_quick_food INTEGER DEFAULT 0,
  portions INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, meal_name)
);

CREATE TABLE ingredients (
  ingredient_id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  calories REAL NOT NULL,
  amount REAL NOT NULL,
  amount_units TEXT NOT NULL,
  protein REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (meal_id) REFERENCES meals(meal_id) ON DELETE CASCADE
);

CREATE INDEX idx_ingredients_meal_id ON ingredients(meal_id);

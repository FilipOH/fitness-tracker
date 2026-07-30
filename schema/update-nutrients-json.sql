-- Add micros/detail column to food_logs and meals
ALTER TABLE food_logs ADD COLUMN nutrients_json TEXT;
ALTER TABLE meals ADD COLUMN nutrients_json TEXT;

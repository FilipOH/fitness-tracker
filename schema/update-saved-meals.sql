-- Add missing columns to saved_meals
ALTER TABLE saved_meals ADD COLUMN portions INTEGER DEFAULT 1;
ALTER TABLE saved_meals ADD COLUMN is_quick_food INTEGER DEFAULT 0;
ALTER TABLE saved_meals ADD COLUMN ingredients TEXT;

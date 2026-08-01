-- Store all three primary macros as first-class columns.
ALTER TABLE food_logs ADD COLUMN carbs REAL NOT NULL DEFAULT 0;
ALTER TABLE food_logs ADD COLUMN fat REAL NOT NULL DEFAULT 0;

ALTER TABLE ingredients ADD COLUMN carbs REAL NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN fat REAL NOT NULL DEFAULT 0;

-- Preserve macro values previously stored in nutrient JSON.
UPDATE food_logs
SET carbs = COALESCE(json_extract(nutrients_json, '$.carbs'), 0),
    fat = COALESCE(json_extract(nutrients_json, '$.fat'), 0)
WHERE nutrients_json IS NOT NULL;

UPDATE ingredients
SET carbs = COALESCE(json_extract(nutrients_json, '$.carbs'), 0),
    fat = COALESCE(json_extract(nutrients_json, '$.fat'), 0)
WHERE nutrients_json IS NOT NULL;
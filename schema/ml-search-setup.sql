-- CoFID (UK Food Database) Local Mirror for high-priority staples
CREATE TABLE IF NOT EXISTS cofid_data (
    cofid_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand TEXT DEFAULT 'Generic (UK CoFID)',
    calories REAL,
    protein REAL,
    fat REAL,
    carbs REAL,
    fiber REAL,
    sugar REAL,
    sodium REAL,
    calcium REAL,
    iron REAL,
    magnesium REAL,
    potassium REAL,
    zinc REAL,
    vitamin_a REAL,
    vitamin_c REAL,
    vitamin_d REAL,
    vitamin_e REAL,
    vitamin_k REAL,
    search_keywords TEXT -- For easier matching
);

-- Search Weights for the ML-assisted model
CREATE TABLE IF NOT EXISTS search_weights (
    feature_name TEXT PRIMARY KEY,
    weight_value REAL DEFAULT 1.0
);

-- Initialize default weights
INSERT OR IGNORE INTO search_weights (feature_name, weight_value) VALUES 
('exact_match', 30000.0),
('starts_with', 10000.0),
('generic_bonus', 15000.0),
('uk_brand_bonus', 25000.0),
('synonym_bonus', 5000.0),
('cofid_bonus', 35000.0), -- Higher than USDA
('shortness_bonus', 1000.0);

-- Feedback store for post-training updates
CREATE TABLE IF NOT EXISTS search_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    result_name TEXT NOT NULL,
    result_source TEXT NOT NULL,
    clicked_rank INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert some CoFID staple data
INSERT INTO cofid_data (name, calories, protein, fat, carbs, fiber, sugar, search_keywords) VALUES
('Aubergine, raw', 18, 1.2, 0.3, 2.3, 2.5, 2.1, 'aubergine eggplant'),
('Courgette, raw', 18, 1.8, 0.4, 1.8, 0.9, 1.7, 'courgette zucchini'),
('Swede, raw', 25, 0.8, 0.2, 4.4, 2.3, 4.3, 'swede rutabaga'),
('Spring Onion, raw', 32, 2.0, 0.5, 4.0, 2.6, 2.3, 'spring onion scallion'),
('Beetroot, raw', 43, 1.6, 0.1, 9.6, 2.8, 6.8, 'beetroot beet'),
('Baby Plum Tomatoes', 18, 0.9, 0.2, 3.9, 1.2, 2.6, 'tomato baby plum grape roma');

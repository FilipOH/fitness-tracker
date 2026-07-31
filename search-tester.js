
const API_BASE = 'https://fitness-api-worker.fhezza314.workers.dev';
const API_KEY = 'my_secret_token_123';

const queries = [
    'baby plum tomatoes',
    'courgette',
    'swede',
    'aubergine',
    'spring onion'
];

function getScore(name, brand, queryStr) {
    if (!name) return 0;
    const n = name.toLowerCase();
    const b = (brand || '').toLowerCase();
    const qClean = queryStr.toLowerCase().replace(/'s/g, '');
    const nClean = n.replace(/'s/g, '');
    const bClean = b.toLowerCase();
    
    const normalize = (w) => w.replace(/es$/, '').replace(/s$/, '').replace(/ies$/, 'y');
    
    const qWords = qClean.split(/\s+/).filter(x => x);
    const qWordsNorm = qWords.map(normalize);
    
    const nWords = nClean.split(/[^a-z0-9]/).filter(x => x);
    const nWordsNorm = nWords.map(normalize);
    
    let score = 0;

    // Synonym Check for UK/US terms
    const isTomato = qWordsNorm.includes('tomato');
    const isPlum = qWordsNorm.includes('plum');
    const isBaby = qWordsNorm.includes('baby');
    const isGrape = nWordsNorm.includes('grape');
    const isRoma = nWordsNorm.includes('roma');
    const isZucchini = nWordsNorm.includes('zucchini');
    const isCourgette = qWordsNorm.includes('courgette');
    const isAubergine = qWordsNorm.includes('aubergine');
    const isEggplant = nWordsNorm.includes('eggplant');
    const isSwede = qWordsNorm.includes('swede');
    const isRutabaga = nWordsNorm.includes('rutabaga');
    const isBeetroot = qWordsNorm.includes('beetroot');
    const isBeet = nWordsNorm.includes('beet');
    const isCoriander = qWordsNorm.includes('coriander');
    const isCilantro = nWordsNorm.includes('cilantro');
    const isSpringOnion = queryStr.toLowerCase().includes('spring onion');
    const isScallion = nWordsNorm.includes('scallion');

    const synonymMatch = (isTomato && isPlum && isBaby && (isGrape || isRoma)) || 
                       (isTomato && isPlum && isRoma) ||
                       (isCourgette && isZucchini) ||
                       (isAubergine && isEggplant) ||
                       (isSwede && isRutabaga) ||
                       (isBeetroot && isBeet) ||
                       (isCoriander && isCilantro) ||
                       (isSpringOnion && isScallion);

    // 1. Exact Match (Highest bonus)
    if (nClean === qClean) score += 30000;
    
    // 2. Starts with query
    if (nClean.startsWith(qClean)) score += 10000;

    // 2.2 Bonus if first word matches first word of query
    if (nWordsNorm[0] === qWordsNorm[0]) score += 8000;

    // 2.5 Word-for-word presence
    const matchCount = qWordsNorm.filter(qw => nWordsNorm.includes(qw)).length;
    const allWordsMatch = matchCount >= qWords.length;
    
    if (allWordsMatch) {
        score += 10000;
        if (nClean.includes(qWords.join(' '))) score += 5000;
        score -= (nWords.length - qWords.length) * 50;
    }

    // 3. Simple inclusion bonus
    if (nClean.includes(qClean)) score += 2000;

    // 4. UK Supermarket & Common Brand Bonus
    const ukBrands = ['tesco', 'aldi', 'asda', 'sainsbury', 'morrisons', 'lidl', 'waitrose', 'm&s', 'marks', 'cadbury', 'iceland', 'maggi'];
    const brandInQuery = ukBrands.some(ub => qClean.includes(ub));
    const brandInResult = ukBrands.some(ub => bClean.includes(ub) || nClean.includes(ub));
    
    if (brandInResult) {
        score += 5000;
        // If user searched for THIS brand, huge bonus
        if (ukBrands.some(ub => qClean.includes(ub) && (bClean.includes(ub) || nClean.includes(ub)))) {
            score += 20000;
        }
    }

    // 5. USDA / Raw Staple Bonus
    if (brand === 'Generic (USDA)') {
        if (matchCount >= Math.min(qWords.length, 2) || synonymMatch) {
            if (brandInQuery) {
                score -= 15000; // Heavily penalize generic if specific brand requested
            } else {
                score += 15000; // Stronger nudge for generics
                if (synonymMatch) score += 5000;
            }
        }
    }

    // 6. Type-specific priority (Fluid Milk over bars)
    if (qWordsNorm.includes('milk')) {
        if (nClean.includes('fluid') || nClean.includes('skimmed') || nClean.includes('semi') || nClean.includes('whole')) score += 10000;
        if (nClean.includes('bar') || nClean.includes('cereal') || nClean.includes('powder')) score -= 20000;
    }

    // 7. Shortness bonus
    score += Math.max(0, 150 - n.length);

    // 8. FINAL Relevance penalty: If a query has multiple words, but match is poor, 
    // kill the score (including shortness bonus).
    if (qWords.length > 1 && matchCount < 2 && !synonymMatch) score = score / 50;
    if (matchCount === 0 && !synonymMatch) score = 0;

    return score;
}

async function runTests() {
    console.log("=== STARTING SEARCH QUALITY TEST ===\n");

    for (const q of queries) {
        console.log(`Query: "${q}"`);
        try {
            let effectiveQuery = q;
            const qLow = q.toLowerCase();
            if (qLow.includes('baby plum') && qLow.includes('tomato')) effectiveQuery += ' grape tomato';
            else if (qLow.includes('plum') && qLow.includes('tomato')) effectiveQuery += ' roma tomato';
            else if (qLow.includes('courgette')) effectiveQuery += ' zucchini';
            else if (qLow.includes('aubergine')) effectiveQuery += ' eggplant';
            else if (qLow.includes('coriander')) effectiveQuery += ' cilantro';
            else if (qLow.includes('spring onion')) effectiveQuery += ' scallion';
            else if (qLow.includes('swede')) effectiveQuery += ' rutabaga';
            else if (qLow.includes('beetroot')) effectiveQuery += ' beet';

            const url = `${API_BASE}/search?q=${encodeURIComponent(effectiveQuery)}&key=${API_KEY}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (!data.products) {
                console.log("  [!] No products found or API error");
                continue;
            }

            const scored = data.products.map(p => ({
                name: p.name,
                brand: p.brand,
                source: p.source,
                score: getScore(p.name, p.brand, q)
            })).sort((a,b) => b.score - a.score);

            scored.slice(0, 5).forEach((p, i) => {
                console.log(`  ${i+1}. [Score: ${p.score}] ${p.name} (${p.brand || 'No Brand'}) | Source: ${p.source}`);
            });
            console.log("");
        } catch (e) {
            console.log(`  [!] Failed: ${e.message}`);
        }
    }
}

runTests();

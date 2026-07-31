
import requests
import json

API_BASE = 'https://fitness-api-worker.fhezza314.workers.dev'
API_KEY = 'my_secret_token_123'

queries = [
    'Milk',
    'Orange',
    "Cadbury's chocolate bar",
    'Iceland takeaway curry',
    'baby plum tomatoes'
]

def get_score(name, brand, query_str):
    if not name: return 0
    n = name.lower()
    b = (brand or '').lower()
    q = query_str.lower()
    q_words = q.split()
    
    score = 0
    
    # Fundamental Rules
    if n == q: score += 5000
    if n.startswith(q): score += 2000
    
    # Word match
    name_words = n.replace('-', ' ').replace(',', ' ').split()
    if all(qw in name_words for qw in q_words): score += 1500
    
    # Inclusion
    if q in n: score += 500
    
    # Multi-word match
    if all(qw in n or qw in b for qw in q_words):
        score += 300
        if all(qw in n for qw in q_words): score += 200
        
    # Shortness (staple bias)
    score += max(0, 100 - len(n))
    
    # Brand match
    if any(qw in b for qw in q_words): score += 100
    
    # UK Retailer Boost
    uk_retailers = ['tesco', 'aldi', 'asda', 'sainsbury', 'morrisons', 'lidl', 'waitrose', 'm&s', 'marks', 'iceland', 'co-op', 'coop']
    if any(r in b or r in n for r in uk_retailers):
        score += 1200 # Increased boost
        
    # Language/Cleanliness
    if n.isascii(): score += 50
    
    return score

def run_tests():
    print(f"{'='*60}")
    print(f"{'SEARCH QUALITY TEST REPORT':^60}")
    print(f"{'='*60}\n")

    for q in queries:
        print(f"QUERY: \"{q}\"")
        try:
            url = f"{API_BASE}/search"
            params = {'q': q, 'key': API_KEY}
            response = requests.get(url, params=params, timeout=10)
            
            if response.status_code != 200:
                print(f"  [!] Error {response.status_code}: {response.text}")
                continue
                
            data = response.json()
            products = data.get('products', [])
            
            if not products:
                print("  [!] No results found.")
                continue
                
            scored = []
            for p in products:
                name = p.get('product_name', 'Unknown')
                brand = p.get('brands', '')
                countries = p.get('countries', 'Unknown')
                score = get_score(name, brand, q)
                scored.append({
                    'name': name,
                    'brand': brand,
                    'countries': countries,
                    'score': score
                })
                
            scored.sort(key=lambda x: x['score'], reverse=True)
            
            for i, p in enumerate(scored[:5]):
                brand_str = f" [{p['brand']}]" if p['brand'] else ""
                print(f"  {i+1}. ({p['score']:>4}) {p['name']}{brand_str}")
                print(f"      Loc: {p['countries']}")
            print("-" * 40)
            
        except Exception as e:
            print(f"  [!] Exception: {e}")

if __name__ == "__main__":
    run_tests()


import requests
import json

def check_nutrients(query):
    url = f"https://world.openfoodfacts.org/cgi/search.pl?search_terms={query}&json=1"
    res = requests.get(url)
    data = res.json()
    
    products = data.get('products', [])
    print(f"Checking results for: {query}")
    for p in products[:10]:
        name = p.get('product_name', 'Unknown')
        brand = p.get('brands', 'Unknown')
        nutriments = p.get('nutriments', {})
        vit_c = nutriments.get('vitamin-c_100g') or nutriments.get('vitamin-c')
        
        print(f"Product: {name} [{brand}]")
        print(f"  Vitamin C (100g): {vit_c}")
        if not vit_c:
            # Check for other vitamin keys
            vits = [k for k in nutriments.keys() if 'vitamin' in k]
            if vits:
                print(f"  Other Vitamins: {vits}")
            else:
                print(f"  No vitamins listed in nutriments.")
        print("-" * 20)

print("--- TARGET SEARCH ---")
check_nutrients("baby plum tomatoes aldi everyday essentials")

print("\n--- BROADER SEARCH ---")
check_nutrients("baby plum tomatoes")

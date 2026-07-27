import boto3
import json
from decimal import Decimal

# Setup DynamoDB
dynamodb = boto3.resource('dynamodb', region_name='eu-west-2')
meals_table = dynamodb.Table('SavedMeals')

# Parsed data from text.txt
meals_to_import = [
    {
        "name": "Spinach and Sweet Potato Curry (with rice and garlic bread)",
        "calories": 907,
        "portions": 1,
        "protein": 0,
        "ingredients": [
            {"item": "Curry Portion", "qty": "1", "cals": 359},
            {"item": "Rice and Garlic Bread", "qty": "1", "cals": 548}
        ]
    },
    {
        "name": "Tomato Gnocchi",
        "calories": 1317,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "Gnocchi", "qty": "1 bag", "cals": 768},
            {"item": "Veg Oil", "qty": "3 tbsp", "cals": 360},
            {"item": "Onion", "qty": "180g", "cals": 72},
            {"item": "Baby Plum Tomatoes", "qty": "450g", "cals": 117}
        ]
    },
    {
        "name": "Banana Pancakes (Full stack)",
        "calories": 2249,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "Batter (inc oil)", "qty": "Full", "cals": 2249}
        ]
    },
    {
        "name": "Cajun Beans and Rice",
        "calories": 1389,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "Baby Plum Tomatoes", "qty": "250g", "cals": 45},
            {"item": "Dry Rice", "qty": "200g", "cals": 750},
            {"item": "Mixed Beans", "qty": "1 tin", "cals": 274},
            {"item": "Onion", "qty": "180g", "cals": 72},
            {"item": "Veg Oil", "qty": "2 tbsp", "cals": 248}
        ]
    },
    {
        "name": "Vegan Breakfast Leftovers Bap",
        "calories": 1279,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "Frying Butter", "qty": "50g", "cals": 340},
            {"item": "Silken Tofu", "qty": "200g", "cals": 140},
            {"item": "Spinach", "qty": "200g", "cals": 60},
            {"item": "Buttered Buns", "qty": "2", "cals": 340},
            {"item": "Hash Browns", "qty": "150g", "cals": 290},
            {"item": "Vegan Sausages", "qty": "2", "cals": 109}
        ]
    },
    {
        "name": "Ratatouille (with rice/pasta)",
        "calories": 2746, # 1313 veg + (359*4) approx for base
        "portions": 4,
        "protein": 0,
        "ingredients": [
            {"item": "Vegetable Mix", "qty": "Batch", "cals": 1313},
            {"item": "Rice/Penne side", "qty": "4 portions", "cals": 1433}
        ]
    },
    {
        "name": "Mushroom Risotto / Stroganoff",
        "calories": 1555,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "White Onion", "qty": "250g", "cals": 0},
            {"item": "Veg Oil", "qty": "2 tbsp", "cals": 0},
            {"item": "Mushrooms", "qty": "250g", "cals": 0},
            {"item": "Rice", "qty": "200g", "cals": 0},
            {"item": "Flora Butter", "qty": "50g", "cals": 0},
            {"item": "White Wine", "qty": "200ml", "cals": 0},
            {"item": "Total Batch", "qty": "1", "cals": 1555}
        ]
    },
    {
        "name": "Thai Green Curry (with rice)",
        "calories": 1893, # 1533 + 360
        "portions": 4,
        "protein": 0,
        "ingredients": [
            {"item": "Curry Batch", "qty": "Batch", "cals": 1533},
            {"item": "Rice", "qty": "100g", "cals": 360}
        ]
    },
    {
        "name": "Simple Gnocchi",
        "calories": 1230,
        "portions": 2,
        "protein": 0,
        "ingredients": [
            {"item": "Gnocchi", "qty": "1 bag", "cals": 768},
            {"item": "Baby Plum Tom", "qty": "250g", "cals": 45},
            {"item": "Garlic", "qty": "15g", "cals": 30},
            {"item": "Olive Oil", "qty": "2 tbsp", "cals": 240},
            {"item": "Onion", "qty": "350g", "cals": 147}
        ]
    }
]

def import_meals():
    print(f"Starting import of {len(meals_to_import)} meals...")
    for idx, meal in enumerate(meals_to_import):
        processed_ing = []
        for ing in meal['ingredients']:
            processed_ing.append({
                'item': ing['item'],
                'qty': str(ing['qty']),
                'cals': Decimal(str(ing['cals']))
            })
        
        item = {
            'MealName': meal['name'],
            'Calories': Decimal(str(meal['calories'])),
            'Protein': Decimal(str(meal['protein'])),
            'Portions': Decimal(str(meal['portions'])),
            'Ingredients': processed_ing
        }
        
        meals_table.put_item(Item=item)
        print(f"[{idx+1}/{len(meals_to_import)}] Imported: {meal['name']}")

if __name__ == "__main__":
    import_meals()
    print("Import complete!")

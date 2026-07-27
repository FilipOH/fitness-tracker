import pandas as pd

# Read data
raw = pd.read_excel('calorie tracker.xlsx', sheet_name='Raw')
day_tracker = pd.read_excel('calorie tracker.xlsx', sheet_name='Day tracker')

# Check specific days
problem_days = ['2026-06-29', '2026-07-06', '2026-07-08', '2026-07-09', '2026-07-20', '2026-07-25']

for day_str in problem_days:
    print(f"\n{'='*60}")
    print(f"Date: {day_str}")
    print('='*60)
    
    # Get food items
    day_food = raw[raw['Day'] == day_str]
    if len(day_food) > 0:
        print("\nFood items:")
        for _, item in day_food.iterrows():
            print(f"  {item['Item']}: {item['Calories']} cal")
        total_in = day_food['Calories'].sum()
        print(f"\nTotal In: {total_in}")
    
    # Get day tracker data
    day_data = day_tracker[day_tracker['Day'] == day_str]
    if len(day_data) > 0:
        row = day_data.iloc[0]
        print(f"\nDay Tracker:")
        print(f"  Total In: {row['Total in']}")
        print(f"  Active Out: {row['Active out']}")
        print(f"  Total Out: {row['Total out']}")
        print(f"  Net: {row['Net']}")
        print(f"  Baseline (Total - Active): {row['Total out'] - row['Active out']}")

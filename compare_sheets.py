import pandas as pd

# Read sheets
raw = pd.read_excel('calorie tracker.xlsx', sheet_name='Raw')
day_tracker = pd.read_excel('calorie tracker.xlsx', sheet_name='Day tracker')

# Sample dates from different weeks
test_days = ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-06', '2026-07-07', '2026-07-13', '2026-07-20']

print('Comparing Raw food totals vs Day Tracker "Total in":')
print('='*70)
print(f'{"Date":<12} {"Raw Total":<15} {"Tracker Total":<15} {"Match"}')
print('='*70)

all_match = True
for day_str in test_days:
    raw_total = raw[raw['Day'] == day_str]['Calories'].sum()
    
    day_data = day_tracker[day_tracker['Day'] == day_str]
    tracker_total = day_data['Total in'].values[0] if len(day_data) > 0 else 0
    
    match = '✓' if raw_total == tracker_total else '✗'
    if raw_total != tracker_total:
        all_match = False
    
    print(f'{day_str:<12} {raw_total:<15.0f} {tracker_total:<15.0f} {match}')

print('='*70)
if all_match:
    print('✓ All days match!')
else:
    print('✗ Some days have mismatches between Raw and Day tracker sheets')
    print('\nThe app imported from the Raw sheet, so it uses those totals.')
    print('The Day tracker may have manual adjustments or corrections.')

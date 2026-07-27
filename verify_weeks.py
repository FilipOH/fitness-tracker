import pandas as pd

# Read Excel data
df = pd.read_excel('calorie tracker.xlsx', sheet_name='Day tracker')
df = df.dropna(subset=['Net'])
df['Day'] = pd.to_datetime(df['Day'])

# Calculate Monday for each day (same logic as the app)
df['DayOfWeek'] = df['Day'].dt.dayofweek
df['DaysToMonday'] = df['DayOfWeek']
df['Monday'] = df['Day'] - pd.to_timedelta(df['DaysToMonday'], unit='D')

# Group by week and sum
weekly = df.groupby('Monday')['Net'].sum()

print('Excel Weekly Sums (by Monday):')
print('='*40)
for monday, net in weekly.items():
    print(f'{monday.strftime("%d-%m")}: {net:.0f}')

print('\n\nApp Weekly Table:')
print('='*40)
print('27-07: -1407')
print('20-07: -6632')
print('13-07: -3851')
print('06-07: -1823')
print('29-06: -4915')

print('\n\nComparison:')
print('='*40)
app_data = {
    '2026-06-29': -4915,
    '2026-07-06': -1823,
    '2026-07-13': -3851,
    '2026-07-20': -6632,
    '2026-07-27': -1407
}

for monday, net in weekly.items():
    monday_str = monday.strftime('%Y-%m-%d')
    app_net = app_data.get(monday_str, 'N/A')
    match = '✓' if net == app_net else '✗'
    print(f'{monday.strftime("%d-%m")}: Excel={net:.0f}, App={app_net}, {match}')

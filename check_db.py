import boto3
import pandas as pd
from decimal import Decimal

dynamodb = boto3.resource('dynamodb', region_name='eu-west-2')
table = dynamodb.Table('CalorieTracker')

# Check 29-06
response = table.query(
    KeyConditionExpression='PK = :pk',
    ExpressionAttributeValues={':pk': '2026-06-29'}
)

print('DynamoDB items for 2026-06-29:')
print('='*70)
food_items = [item for item in response['Items'] if item['Type'] == 'FOOD']
total_cal = sum(float(item['Value']) for item in food_items)

for item in food_items:
    print(f"  {item.get('Note', 'N/A')}: {item['Value']} cal at {item.get('Timestamp', 'N/A')}")

print(f'\nTotal Food: {total_cal} cal')
print(f'Expected (from Excel): 1224 cal')
print(f'Difference: {total_cal - 1224}')

# Check Excel Raw sheet for comparison
print('\n' + '='*70)
print('Excel Raw sheet for 2026-06-29:')
print('='*70)
raw = pd.read_excel('calorie tracker.xlsx', sheet_name='Raw')
day_29 = raw[raw['Day'] == '2026-06-29']
for _, row in day_29.iterrows():
    print(f"  {row['Item']}: {row['Calories']} cal at {row['Time']}")
print(f'\nTotal: {day_29["Calories"].sum()} cal')

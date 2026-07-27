import boto3
import pandas as pd
from decimal import Decimal

# CONFIGURATION
EXCEL_FILE = 'calorie tracker.xlsx'
TABLE_NAME = 'CalorieTracker'
REGION = 'eu-west-2'

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

def clear_old_data():
    """Delete all entries before today (2026-07-27) to preserve today's data"""
    print("Scanning for old entries...")
    
    # Get all items
    response = table.scan()
    items = response['Items']
    
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response['Items'])
    
    # Filter to dates before 2026-07-27
    old_items = [item for item in items if item['PK'] < '2026-07-27']
    
    print(f"Found {len(old_items)} old entries to delete...")
    
    # Delete in batches
    with table.batch_writer() as batch:
        for item in old_items:
            batch.delete_item(Key={'PK': item['PK'], 'SK': item['SK']})
            
    print(f"Deleted {len(old_items)} old entries")

def reimport_from_excel():
    """Import historical data from Excel"""
    print(f"\nReading {EXCEL_FILE}...")
    xl = pd.ExcelFile(EXCEL_FILE)
    
    # 1. Import Food items (Raw sheet)
    if 'Raw' in xl.sheet_names:
        print("Importing Food logs...")
        raw_df = pd.read_excel(xl, 'Raw')
        food_count = 0
        # Track counter per (date, time) to make SK unique
        time_counters = {}
        
        for _, row in raw_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Calories']): 
                continue
            date_str = str(row['Day']).split(' ')[0]
            
            # Skip today's date
            if date_str >= '2026-07-27':
                continue
                
            time_str = str(row['Time']) if not pd.isna(row['Time']) else "12:00:00"
            
            # Add counter to make SK unique for items at same time
            key = f"{date_str}#{time_str}"
            if key not in time_counters:
                time_counters[key] = 0
            else:
                time_counters[key] += 1
            
            counter = time_counters[key]
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"FOOD#{time_str}#{counter}",
                'Type': 'FOOD',
                'Value': Decimal(str(row['Calories'])),
                'Note': str(row['Item']),
                'Timestamp': time_str
            })
            food_count += 1
        print(f"  Imported {food_count} food entries")

    # 2. Import Weights (Dashboard sheet)
    if 'Dashboard' in xl.sheet_names:
        print("Importing Weight logs...")
        dash_df = pd.read_excel(xl, 'Dashboard')
        weight_count = 0
        for _, row in dash_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Weight in']): 
                continue
            date_str = str(row['Day']).split(' ')[0]
            
            # Skip today's date
            if date_str >= '2026-07-27':
                continue
            
            # Get weight time from Day tracker if available
            time_str = "08:00:00"  # Default morning weight
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"WEIGHT#{time_str}",
                'Type': 'WEIGHT',
                'Value': Decimal(str(row['Weight in'])),
                'Timestamp': time_str
            })
            weight_count += 1
        print(f"  Imported {weight_count} weight entries")

    # 3. Import Active Calories (Day tracker sheet)
    if 'Day tracker' in xl.sheet_names:
        print("Importing Active Calories...")
        day_df = pd.read_excel(xl, 'Day tracker')
        active_count = 0
        for _, row in day_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Active out']): 
                continue
            date_str = str(row['Day']).split(' ')[0]
            
            # Skip today's date
            if date_str >= '2026-07-27':
                continue
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"ACTIVE#{row['Weight time'] if not pd.isna(row.get('Weight time')) else '23:00:00'}",
                'Type': 'ACTIVE',
                'Value': Decimal(str(row['Active out'])),
                'Timestamp': str(row['Weight time']) if not pd.isna(row.get('Weight time')) else "23:00:00"
            })
            active_count += 1
        print(f"  Imported {active_count} active calorie entries")

    print("\n✓ Re-import complete!")

if __name__ == "__main__":
    print("="*60)
    print("HISTORICAL DATA FIX")
    print("This will clear all data before 2026-07-27 and re-import from Excel")
    print("="*60)
    
    clear_old_data()
    reimport_from_excel()
    
    print("\nDone! Refresh your dashboard to see corrected data.")

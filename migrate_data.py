import pandas as pd
import boto3
import json
from decimal import Decimal
from datetime import datetime

# CONFIGURATION
EXCEL_FILE = 'calorie tracker.xlsx'
TABLE_NAME = 'CalorieTracker'
REGION = 'eu-west-2'

# Initialize DynamoDB Client
dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

def migrate():
    print(f"Reading {EXCEL_FILE}...")
    xl = pd.ExcelFile(EXCEL_FILE)
    
    # 1. Migrate Food (Raw sheet)
    if 'Raw' in xl.sheet_names:
        print("Migrating Food logs...")
        raw_df = pd.read_excel(xl, 'Raw')
        for _, row in raw_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Calories']): continue
            date_str = str(row['Day']).split(' ')[0]
            time_str = str(row['Time']) if not pd.isna(row['Time']) else "12:00:00"
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"FOOD#{time_str}",
                'Type': 'FOOD',
                'Value': Decimal(str(row['Calories'])),
                'Note': str(row['Item']),
                'Timestamp': time_str
            })

    # 2. Migrate Weights (Dashboard sheet)
    if 'Dashboard' in xl.sheet_names:
        print("Migrating Weight logs...")
        dash_df = pd.read_excel(xl, 'Dashboard')
        for _, row in dash_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Weight in']): continue
            date_str = str(row['Day']).split(' ')[0]
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"WEIGHT#08:00:00", # Assumed morning weight
                'Type': 'WEIGHT',
                'Value': Decimal(str(row['Weight in'])),
                'Timestamp': "08:00:00"
            })

    # 3. Migrate Active Calories (Day tracker sheet)
    if 'Day tracker' in xl.sheet_names:
        print("Migrating Active Calories...")
        day_df = pd.read_excel(xl, 'Day tracker')
        for _, row in day_df.iterrows():
            if pd.isna(row['Day']) or pd.isna(row['Active out']): continue
            date_str = str(row['Day']).split(' ')[0]
            
            table.put_item(Item={
                'PK': date_str,
                'SK': f"ACTIVE#23:00:00",
                'Type': 'ACTIVE',
                'Value': Decimal(str(row['Active out'])),
                'Timestamp': "23:00:00"
            })

    print("Migration complete!")

if __name__ == "__main__":
    migrate()

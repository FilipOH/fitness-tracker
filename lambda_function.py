import json
import boto3
import os
from datetime import datetime
from decimal import Decimal
from boto3.dynamodb.conditions import Key

# Initialize DynamoDB
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ.get('TABLE_NAME', 'CalorieTracker'))
meals_table = dynamodb.Table(os.environ.get('MEALS_TABLE', 'SavedMeals'))

def lambda_handler(event, context):
    API_KEY = os.environ.get('API_KEY', 'my_secret_token_123')
    BASELINE = Decimal(os.environ.get('BASELINE_CALS', '1800'))
    
    # Handle CORS preflight
    method = event.get('requestContext', {}).get('http', {}).get('method')
    if method == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type,x-api-key'
            },
            'body': ''
        }
    
    path = event.get('requestContext', {}).get('http', {}).get('path')
    
    # Handle Meals API
    if path == '/meals':
        if method == 'POST': return handle_meal_post(event, API_KEY)
        if method == 'GET': return handle_meal_get(event, API_KEY)
    
    # Handle Data API
    if path == '/data':
        return handle_get(event, API_KEY, BASELINE)
    
    if method == 'POST':
        return handle_post(event, API_KEY)
        
    return {'statusCode': 404, 'body': 'Not Found'}

def handle_meal_post(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'body': 'Unauthorized'}
    try:
        body = json.loads(event.get('body', '{}'))
        meals_table.put_item(Item={
            'MealName': body['name'],
            'Calories': Decimal(str(body['calories'])),
            'Protein': Decimal(str(body.get('protein') or 0)),
            'Ingredients': body.get('ingredients', []),
            'Portions': Decimal(str(body.get('portions') or 1))
        })
        return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Saved'}
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': str(e)}

def handle_meal_get(event, api_key):
    # (Simplified scan for personal project)
    response = meals_table.scan()
    class DecimalEncoder(json.JSONEncoder):
        def default(self, obj):
            if isinstance(obj, Decimal): return float(obj)
            return super(DecimalEncoder, self).default(obj)
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
        'body': json.dumps({'meals': response.get('Items', [])}, cls=DecimalEncoder)
    }

def handle_post(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'Unauthorized'})}

    try:
        body = json.loads(event.get('body', '{}'))
        data_type = body.get('type') # FOOD, WEIGHT, ACTIVE, SLEEP, GYM
        value = Decimal(str(body.get('value', 0)))
        note = body.get('note', '')
        protein = Decimal(str(body.get('protein', 0))) if data_type == 'FOOD' else 0
        custom_time = body.get('time') # HH:MM
        
        now = datetime.now()
        date_str = now.strftime('%Y-%m-%d')
        
        # Determine the time suffix
        if custom_time:
            # Ensure it's formatted as HH:MM:SS to match automatic logs
            time_str = f"{custom_time}:00"
        else:
            time_str = now.strftime('%H:%M:%S')

        # Logic: Some types should overwrite for the day (Active Cals, Weight, Sleep)
        # while others (Food, Gym) should allow multiple entries.
        if data_type in ['ACTIVE', 'WEIGHT', 'SLEEP']:
            sk = f"{data_type}#DAILY"
        else:
            sk = f"{data_type}#{time_str}"

        item = {
            'PK': date_str,
            'SK': sk,
            'Type': data_type,
            'Value': value,
            'Note': note,
            'Timestamp': time_str
        }
        if data_type == 'FOOD':
            item['Protein'] = protein

        table.put_item(Item=item)
        return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'message': 'Logged'})}
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': str(e)})}

def handle_get(event, api_key, baseline):
    # Quick security check via query string for dashboard
    params = event.get('queryStringParameters', {})
    if params is None: params = {}
    if params.get('key') != api_key:
        return {'statusCode': 403, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Unauthorized'}

    # Fetch last 30 days of data
    response = table.scan() # Personal project scale
    items = response.get('Items', [])
    
    class DecimalEncoder(json.JSONEncoder):
        def default(self, obj):
            if isinstance(obj, Decimal): return float(obj)
            return super(DecimalEncoder, self).default(obj)

    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps({
            'items': items,
            'baseline': float(baseline)
        }, cls=DecimalEncoder)
    }


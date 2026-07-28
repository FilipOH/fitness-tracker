import json
import boto3
import os
from datetime import datetime, timedelta
from decimal import Decimal
from boto3.dynamodb.conditions import Key
import pyotp
import secrets

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
                'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type,x-api-key'
            },
            'body': ''
        }
    
    path = event.get('requestContext', {}).get('http', {}).get('path')
    
    # Handle Auth/MFA API
    if path == '/verify-totp':
        if method == 'POST': return handle_verify_totp(event)
    
    if path == '/trust-device':
        if method == 'POST': return handle_trust_device(event, API_KEY)
        if method == 'GET': return handle_check_device_trust(event)
    
    # Handle Meals API
    if path == '/meals':
        if method == 'POST': return handle_meal_post(event, API_KEY)
        if method == 'GET': return handle_meal_get(event, API_KEY)
        if method == 'DELETE': return handle_meal_delete(event, API_KEY)
    
    # Handle Config API
    if path == '/config':
        if method == 'POST': return handle_config_post(event, API_KEY)
        if method == 'GET': return handle_config_get(event, API_KEY)
    
    # Handle Data API
    if path == '/data':
        return handle_get(event, API_KEY, BASELINE)
    
    if method == 'POST':
        return handle_post(event, API_KEY)
    
    if method == 'DELETE' and path == '/log':
        return handle_delete_log(event, API_KEY)
        
    return {'statusCode': 404, 'body': 'Not Found'}

def handle_meal_post(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'body': 'Unauthorized'}
    try:
        body = json.loads(event.get('body', '{}'))
        item = {
            'MealName': body['name'],
            'Calories': Decimal(str(body['calories'])),
            'Protein': Decimal(str(body.get('protein') or 0)),
            'Ingredients': body.get('ingredients', []),
            'Portions': Decimal(str(body.get('portions') or 1))
        }
        # Add isQuickFood flag if present (use lowercase 'i' to match frontend)
        if 'isQuickFood' in body:
            item['isQuickFood'] = bool(body['isQuickFood'])
        
        meals_table.put_item(Item=item)
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

def handle_meal_delete(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'body': 'Unauthorized'}
    try:
        name = event.get('queryStringParameters', {}).get('name')
        if not name:
            body = json.loads(event.get('body', '{}'))
            name = body.get('name')
        
        meals_table.delete_item(Key={'MealName': name})
        return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Deleted'}
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': str(e)}

def handle_config_post(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'body': 'Unauthorized'}
    try:
        body = json.loads(event.get('body', '{}'))
        effective_date = body.get('effectiveDate') or datetime.now().strftime('%Y-%m-%d')
        
        # Get existing config to access history
        response = table.get_item(Key={'PK': 'CONFIG', 'SK': 'GOALS'})
        existing = response.get('Item', {})
        history = existing.get('history', [])
        
        # Create new goals object with effectiveDate
        new_goals = {
            'weeklyNet': Decimal(str(body['goals']['weeklyNet'])),
            'weeklyComparison': body['goals'].get('weeklyComparison', 'less'),
            'protein': Decimal(str(body['goals']['protein'])),
            'sleep': Decimal(str(body['goals']['sleep'])),
            'gym': Decimal(str(body['goals']['gym'])),
            'effectiveDate': effective_date
        }
        
        # Append to history and sort by date
        history.append(new_goals)
        history.sort(key=lambda x: x.get('effectiveDate', '1970-01-01'))
        
        # Save with both current and history
        item = {
            'PK': 'CONFIG',
            'SK': 'GOALS',
            'Goals': new_goals,
            'history': history
        }
        table.put_item(Item=item)
        return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Saved'}
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': str(e)}

def handle_config_get(event, api_key):
    try:
        response = table.get_item(Key={'PK': 'CONFIG', 'SK': 'GOALS'})
        item = response.get('Item', {})
        
        class DecimalEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, Decimal): return float(obj)
                return super(DecimalEncoder, self).default(obj)
        
        # Return both current goals and full history
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                'goals': item.get('Goals', {}),
                'history': item.get('history', [])
            }, cls=DecimalEncoder)
        }
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': str(e)}

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
        custom_time = body.get('time') # Can be HH:MM or HH:MM:SS
        custom_date = body.get('date') # YYYY-MM-DD
        
        now = datetime.now()
        date_str = custom_date if custom_date else now.strftime('%Y-%m-%d')
        
        # Determine the time suffix
        if custom_time:
            # Ensure it's formatted as HH:MM:SS (add :00 if only HH:MM provided)
            time_str = custom_time if custom_time.count(':') == 2 else f"{custom_time}:00"
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

def handle_delete_log(event, api_key):
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Unauthorized'}
    
    try:
        params = event.get('queryStringParameters', {})
        pk = params.get('pk')
        sk = params.get('sk')
        
        if not pk or not sk:
            return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Missing pk or sk'}
        
        table.delete_item(Key={'PK': pk, 'SK': sk})
        return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': 'Deleted'}
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': str(e)}

def handle_verify_totp(event):
    """Verify TOTP code - no API key required (public endpoint)"""
    try:
        body = json.loads(event.get('body', '{}'))
        totp_code = body.get('code')
        
        if not totp_code:
            return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'Code required'})}
        
        # Get TOTP secret from environment (set by user manually)
        totp_secret = os.environ.get('TOTP_SECRET')
        if not totp_secret:
            return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'TOTP not configured'})}
        
        # Verify the code (allow 1 period before/after for clock drift)
        totp = pyotp.TOTP(totp_secret)
        is_valid = totp.verify(totp_code, valid_window=1)
        
        if is_valid:
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'success': True, 'message': 'TOTP verified'})
            }
        else:
            return {
                'statusCode': 401,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'success': False, 'error': 'Invalid code'})
            }
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': str(e)})}

def handle_trust_device(event, api_key):
    """Issue a trusted device token after successful auth"""
    headers = {k.lower(): v for k, v in event.get('headers', {}).items()}
    if headers.get('x-api-key') != api_key:
        return {'statusCode': 403, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'Unauthorized'})}
    
    try:
        body = json.loads(event.get('body', '{}'))
        device_fingerprint = body.get('deviceFingerprint')
        
        if not device_fingerprint:
            return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'Device fingerprint required'})}
        
        # Generate a secure token for this device
        device_token = secrets.token_urlsafe(32)
        expiry = (datetime.now() + timedelta(days=90)).isoformat()
        
        # Store in DynamoDB
        item = {
            'PK': 'DEVICE',
            'SK': device_fingerprint,
            'Token': device_token,
            'ExpiresAt': expiry,
            'CreatedAt': datetime.now().isoformat()
        }
        table.put_item(Item=item)
        
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                'success': True,
                'deviceToken': device_token,
                'expiresAt': expiry
            })
        }
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': str(e)})}

def handle_check_device_trust(event):
    """Check if a device token is valid (no API key needed - token itself is proof)"""
    try:
        params = event.get('queryStringParameters', {}) or {}
        device_fingerprint = params.get('deviceFingerprint')
        device_token = params.get('deviceToken')
        
        if not device_fingerprint or not device_token:
            return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'trusted': False})}
        
        # Check DynamoDB
        response = table.get_item(Key={'PK': 'DEVICE', 'SK': device_fingerprint})
        item = response.get('Item')
        
        if not item:
            return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'trusted': False})}
        
        # Verify token matches and hasn't expired
        stored_token = item.get('Token')
        expiry = item.get('ExpiresAt')
        
        if stored_token != device_token:
            return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'trusted': False})}
        
        if expiry and datetime.fromisoformat(expiry) < datetime.now():
            return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'trusted': False, 'reason': 'expired'})}
        
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'trusted': True, 'expiresAt': expiry})
        }
    except Exception as e:
        return {'statusCode': 500, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': str(e)})}



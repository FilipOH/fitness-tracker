# Serverless Fitness Tracker

An ultra-cheap, serverless, iPhone-compatible fitness tracking workflow.

## Features
- **S3-Hosted Dashboard**: Mobile-optimized UI with Chart.js visualization.
- **DynamoDB Backend**: Fast, scalable storage for calories, weight, gym, and sleep scores.
- **AWS Lambda API**: Python backend handling data routing and meal template management.
- **iOS Shortcut Integration**: Log food, workouts, and health data directly from Apple Watch/iPhone via API Gateway.
- **Security**: Password-protected dashboard and API Key validation.
- **Advanced Metrics**: 4-day rolling weight average, weekly goal tracking, and Apple Watch Sleep Score analytics.

## Tech Stack
- **Frontend**: HTML5/CSS3, JavaScript (Vanilla + jQuery/Select2), Chart.js, Font Awesome.
- **Backend**: AWS Lambda (Python), API Gateway v2.
- **Database**: Amazon DynamoDB.
- **Deployment**: AWS SAM (Serverless Application Model).

## Deployment
1. Build and deploy the backend:
    ```bash
    sam build
    sam deploy --guided
    ```
2. Upload the dashboard to S3:
    ```bash
    aws s3 cp index.html s3://your-bucket-name/index.html
    aws s3 cp manifest.json s3://your-bucket-name/manifest.json
    ```

## Security
- **Password Protection**: Dashboard requires password (stored in session only, clears on browser close)
- **API Key Validation**: All Lambda requests validate the API key server-side
- **Static Site Limitation**: API key is visible in client code (unavoidable for static S3 sites)
- **Protection Against Abuse**: 
  - Lambda validates API key on every request
  - AWS API Gateway has built-in DDoS protection
  - Can add AWS WAF for advanced rate limiting if needed
- **Key Rotation**: If the API key is compromised:
  1. Update `API_KEY` in `template.yaml` (Lambda environment variable)
  2. Redeploy: `sam build && sam deploy`
  3. Update `API_KEY` in `index.html` 
  4. Upload: `aws s3 cp index.html s3://calorie-dashboard-667140111962/index.html`

## Cost
Running costs are typically **$0.50-2.00/month** for personal use:
- DynamoDB: Pay-per-request pricing (~$0.25/month)
- Lambda: 1M free requests/month, then $0.20 per 1M
- API Gateway: 1M free requests/month, then $1.00 per 1M
- S3: Static hosting is pennies (~$0.023/month for 1GB)


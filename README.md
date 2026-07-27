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
    ```

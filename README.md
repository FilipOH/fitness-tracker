# Serverless Fitness Tracker (Cloudflare Edition)

An ultra-cheap, serverless, iPhone-compatible fitness tracking workflow migrated from AWS to Cloudflare.

## Features
- **GitHub Pages Dashboard**: Mobile-optimized PWA UI with Chart.js visualization.
- **Cloudflare D1 Backend**: SQLite-based relational storage for calories, weight, gym, and exercise logs.
- **Cloudflare Workers API**: Modern JS backend handling data routing, authentication (TOTP), and meal management.
- **MFA Security**: TOTP-based Multi-Factor Authentication for secure access.
- **iOS Shortcut Integration**: Log food, workouts, and health data directly from Apple Watch/iPhone via the Worker API.
- **Advanced Metrics**: 7-day rolling weight average, weekly goal tracking, and progress visualization.

## Tech Stack
- **Frontend**: HTML5/CSS3, JavaScript (Vanilla + jQuery/Select2), Chart.js, Font Awesome.
- **Backend**: Cloudflare Workers (JavaScript/ESM).
- **Database**: Cloudflare D1 (SQLite).
- **Hosting**: GitHub Pages (`/docs` folder).

## Project Structure
- `fitness-worker/`: The Cloudflare Worker API source.
- `docs/`: The PWA frontend hosted on GitHub Pages.
- `aws-archive/`: Legacy AWS infrastructure and data exports.
- `*.sql`: D1 Database schema and setup scripts.

## Setup
1. **Database**: Initialize D1 using `auth-setup.sql` and `cloudflare-d1-schema.sql`.
2. **Worker**: Deploy the API with `npx wrangler deploy` from the `fitness-worker` directory.
3. **Frontend**: The UI in `docs/` is configured to point to the `fitness-api-worker` URL.
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


import pandas as pd

file_path = 'calorie tracker.xlsx'
try:
    # Read all sheets
    xl = pd.ExcelFile(file_path)
    print(f"Sheets: {xl.sheet_names}")
    
    for sheet in xl.sheet_names:
        print(f"\n--- Sheet: {sheet} ---")
        df = pd.read_excel(file_path, sheet_name=sheet)
        print("Columns:", df.columns.tolist())
        print("Data (First 5 rows):")
        print(df.head())
except Exception as e:
    print(f"Error: {e}")

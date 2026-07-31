import pandas as pd
import requests
import os
import re

url = "https://assets.publishing.service.gov.uk/media/60538b91e90e07527df82ae4/McCance_Widdowsons_Composition_of_Foods_Integrated_Dataset_2021..xlsx"
filename = "cofid_2021.xlsx"

if not os.path.exists(filename):
    print(f"Downloading {filename}...")
    r = requests.get(url)
    with open(filename, 'wb') as f:
        f.write(r.content)

def clean_val(val):
    if pd.isna(val): return "NULL"
    s = str(val).strip().lower()
    if s == 'n' or s == '-': return "NULL"
    if s == 'tr': return "0.01" # Trace
    # Remove any non-numeric characters except decimal point
    s = re.sub(r'[^\d.]', '', s)
    if not s: return "NULL"
    try:
        float(s)
        return s
    except:
        return "NULL"

print("Processing CoFID sheets...")
# Read sheets, skip header rows to get to the data
df_prox = pd.read_excel(filename, sheet_name='1.3 Proximates', skiprows=2)
df_inor = pd.read_excel(filename, sheet_name='1.4 Inorganics', skiprows=2)
df_vit = pd.read_excel(filename, sheet_name='1.5 Vitamins', skiprows=2)

# Set correct column names based on my observation
# prox: 0=code, 1=name, 9=PROT, 10=FAT, 11=CHO, 12=KCALS, 16=TOTSUG, 25=AOACFIB
# inor: 0=code, 7=Sodium, 8=K, 9=CA, 10=MG, 12=FE, 14=ZN
# vit: 0=code, 9=RETEQU, 10=VITD, 11=VITE, 12=VITK1, 23=VITC

df_prox = df_prox.iloc[:, [0, 1, 9, 10, 11, 12, 16, 25]]
df_prox.columns = ['code', 'name', 'protein', 'fat', 'carbs', 'calories', 'sugar', 'fiber']

df_inor = df_inor.iloc[:, [0, 7, 8, 9, 10, 12, 14]]
df_inor.columns = ['code', 'sodium', 'potassium', 'calcium', 'magnesium', 'iron', 'zinc']

df_vit = df_vit.iloc[:, [0, 9, 10, 11, 12, 23]]
df_vit.columns = ['code', 'vitamin_a', 'vitamin_d', 'vitamin_e', 'vitamin_k', 'vitamin_c']

# Merge all
df = df_prox.merge(df_inor, on='code', how='left').merge(df_vit, on='code', how='left')

# Drop rows without a name or where name is just headers
df = df[df['name'].notna()]
df = df[df['name'] != 'Food Name']

print(f"Total foods to import: {len(df)}")

sql_file = "cofid_import.sql"
with open(sql_file, 'w', encoding='utf-8') as f:
    f.write("-- Full CoFID Import\n")
    f.write("DELETE FROM cofid_data;\n") # Clean start
    
    for _, row in df.iterrows():
        name = str(row['name']).replace("'", "''")
        keywords = name.lower().replace(",", " ").replace("(", " ").replace(")", " ")
        
        vals = [
            f"'{name}'",
            "'Generic (UK CoFID)'",
            clean_val(row['calories']),
            clean_val(row['protein']),
            clean_val(row['fat']),
            clean_val(row['carbs']),
            clean_val(row['fiber']),
            clean_val(row['sugar']),
            clean_val(row['sodium']),
            clean_val(row['calcium']),
            clean_val(row['iron']),
            clean_val(row['magnesium']),
            clean_val(row['potassium']),
            clean_val(row['zinc']),
            clean_val(row['vitamin_a']),
            clean_val(row['vitamin_c']),
            clean_val(row['vitamin_d']),
            clean_val(row['vitamin_e']),
            clean_val(row['vitamin_k']),
            f"'{keywords}'"
        ]
        
        sql = f"INSERT INTO cofid_data (name, brand, calories, protein, fat, carbs, fiber, sugar, sodium, calcium, iron, magnesium, potassium, zinc, vitamin_a, vitamin_c, vitamin_d, vitamin_e, vitamin_k, search_keywords) VALUES ({', '.join(vals)});\n"
        f.write(sql)

print(f"SQL file generated: {sql_file}")

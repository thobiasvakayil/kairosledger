import json
import os
import sqlite3

SRC_DB = 'Kairoserec.db'
DEST_DB = 'Kairoserec_relevant.db'
SEED_JS = 'db_seed_relevant.js'

if not os.path.exists(SRC_DB):
    raise FileNotFoundError(f"Source database not found: {SRC_DB}")

if os.path.exists(DEST_DB):
    os.remove(DEST_DB)

src_conn = sqlite3.connect(SRC_DB)
src_conn.row_factory = sqlite3.Row
src_cur = src_conn.cursor()

dest_conn = sqlite3.connect(DEST_DB)
dest_cur = dest_conn.cursor()

# copy table schema and rows for the relevant tables
for table_name in ['FOK', 'Banktransaction', 'trntype', 'trnbanknametable']:
    row = src_cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table_name,)).fetchone()
    if row is None or not row['sql']:
        raise ValueError(f"Table not found in source DB: {table_name}")

    dest_cur.execute(row['sql'])
    cols = [info[1] for info in src_cur.execute(f"PRAGMA table_info({table_name})")]
    placeholders = ','.join('?' for _ in cols)
    insert_sql = f"INSERT INTO {table_name} ({', '.join(cols)}) VALUES ({placeholders})"

    rows = src_cur.execute(f"SELECT * FROM {table_name}").fetchall()
    dest_cur.executemany(insert_sql, [tuple(r[col] for col in cols) for r in rows])
    print(f"Copied {len(rows)} rows from {table_name}")

# create helpful indexes for the trimmed DB
indexes = [
    "CREATE INDEX IF NOT EXISTS idx_FOK_upi_id ON FOK(upi_id)",
    "CREATE INDEX IF NOT EXISTS idx_FOK_full_name ON FOK(full_name)",
    "CREATE INDEX IF NOT EXISTS idx_Banktransaction_Particulars ON Banktransaction(Particulars)",
    "CREATE INDEX IF NOT EXISTS idx_Banktransaction_TranID ON Banktransaction(TranID)"
]
for idx_sql in indexes:
    dest_cur.execute(idx_sql)

dest_conn.commit()
dest_conn.close()

# Generate smaller JS seed file for the browser app
fok_rows = src_cur.execute('SELECT * FROM FOK').fetchall()
bank_rows = src_cur.execute('SELECT * FROM Banktransaction').fetchall()
trntype_rows = src_cur.execute('SELECT * FROM trntype').fetchall()
bank_name_rows = src_cur.execute('SELECT * FROM trnbanknametable').fetchall()

# Build simplified app seed arrays

def normalize_value(value):
    if value is None:
        return ''
    text = str(value).strip()
    if text.lower() in {'none', 'null', 'nan'}:
        return ''
    return text

people = []
for row in fok_rows:
    name = normalize_value(row['full_name']) or ' '.join(filter(None, [normalize_value(row['first_name']), normalize_value(row['last_name'])])) or normalize_value(row['title']) or 'Unknown'
    upi = normalize_value(row['upi_id']) or normalize_value(row['email_id']) or name
    bnk_ref = normalize_value(row['Bnktrn_ID'])
    people.append({
        'id': str(row['id']),
        'name': name,
        'upis': upi,
        'upi_id': normalize_value(row['upi_id']),
        'bnktrn_id': bnk_ref,
        'agent': normalize_value(row['TransAdmin']),
        'type': 'Charity'
    })

trn_type_lookup = {}
trn_types = []
for row in trntype_rows:
    trn_id = normalize_value(row['ID'])
    trn_name = normalize_value(row['TrnType'])
    trn_desc = normalize_value(row['Description'])
    if trn_id:
        trn_type_lookup[trn_id] = trn_name
    trn_types.append({
        'id': trn_id,
        'name': trn_name,
        'description': trn_desc
    })

bank_lookup = {}
banks = []
for row in bank_name_rows:
    bank_id = normalize_value(row['ID'])
    bank_name = normalize_value(row['BankName'])
    if bank_id:
        bank_lookup[bank_id] = bank_name
    banks.append({
        'id': bank_id,
        'name': bank_name
    })


def map_trn_type_tag(tag_value, fallback_type):
    raw_tag = normalize_value(tag_value)
    if not raw_tag:
        return normalize_value(fallback_type) or 'Uncategorized'

    names = []
    for token in [t.strip() for t in raw_tag.split(',') if t.strip()]:
        names.append(trn_type_lookup.get(token, token))

    unique_names = []
    for name in names:
        if name not in unique_names:
            unique_names.append(name)

    return ' | '.join(unique_names) if unique_names else (normalize_value(fallback_type) or 'Uncategorized')


def map_bank_name(bank_value):
    raw_bank = normalize_value(bank_value)
    if not raw_bank:
        return 'Unassigned Bank'
    return bank_lookup.get(raw_bank, raw_bank)

transactions = []
for row in bank_rows:
    deposit = row['Deposit']
    withdrawal = row['Withdrawal']
    if deposit is None:
        deposit = 0.0
    if withdrawal is None:
        withdrawal = 0.0
    amount = deposit if deposit != 0 else -float(withdrawal)
    mapped_trn_type_name = map_trn_type_tag(row['TrnTypeTag'], row['TranType'])
    bank_name = map_bank_name(row['trnbankname'])

    transactions.append({
        'date': normalize_value(row['TranDate']),
        'description': normalize_value(row['Particulars']),
        'amount': amount,
        'type': mapped_trn_type_name,
        'trnTypeTag': normalize_value(row['TrnTypeTag']),
        'trnTypeName': mapped_trn_type_name,
        'bankId': normalize_value(row['trnbankname']),
        'bankName': bank_name,
        'ref': normalize_value(row['TranID']) or str(normalize_value(row['SlNo'])),
        'tran_id': normalize_value(row['TranID']) or str(normalize_value(row['SlNo']))
    })

seed_content = {
    'people': people,
    'transactions': transactions,
    'trnTypes': trn_types,
    'banks': banks
}

with open(SEED_JS, 'w', encoding='utf-8') as fh:
    fh.write('// Generated seed data from Kairoserec.db containing only FOK and Banktransaction rows\n')
    fh.write('// This file is intentionally smaller than the full original database export.\n')
    fh.write('const SEED_DATABASE = ')
    json.dump(seed_content, fh, separators=(',', ':'), ensure_ascii=False)
    fh.write(';\n')

src_conn.close()
print(f"Created trimmed SQLite database: {DEST_DB}")
print(f"Created smaller JS seed file: {SEED_JS}")
print(f"People records: {len(people)}")
print(f"Transaction records: {len(transactions)}")

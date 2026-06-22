import json
import hashlib
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE_DB = Path(os.environ.get('SOURCE_DB', ROOT / 'Kairoserec_relevant.db'))
SCHEMA_FILE = ROOT / 'azure_sql_schema.sql'
OUTPUT_FILE = ROOT / 'azure_sql_migration.sql'


def normalize_value(value):
    if value is None:
        return ''
    text = str(value).strip()
    if text.lower() in {'none', 'null', 'nan'}:
        return ''
    return text


def sql_string(value):
    text = normalize_value(value)
    if not text:
        return 'NULL'
    return "N'" + text.replace("'", "''") + "'"


def sql_decimal(value):
    if value is None or value == '':
        return '0'
    try:
        return str(float(value))
    except (TypeError, ValueError):
        return '0'


def sql_date(value):
    text = normalize_value(value)
    if not text:
                return 'NULL'
    return sql_string(text[:10])


def to_int(value, default=None):
    try:
        if value is None:
            return default
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def hash_password(password, salt_seed):
    salt = hashlib.sha256(str(salt_seed).encode('utf-8')).hexdigest()[:32]
    digest = hashlib.scrypt(
        password.encode('utf-8'),
        salt=salt.encode('utf-8'),
        n=16384,
        r=8,
        p=1,
        dklen=64
    ).hex()
    return f'{salt}:{digest}'


def insert_rows(table_name, columns, rows):
    if not rows:
        return [f'-- No rows found for {table_name}']

    statements = []
    col_list = ', '.join(columns)
    for row in rows:
        values = ', '.join(row)
        statements.append(f'INSERT INTO dbo.{table_name} ({col_list}) VALUES ({values});')
    return statements


if not SOURCE_DB.exists():
    raise FileNotFoundError(f'Source database not found: {SOURCE_DB}')

if not SCHEMA_FILE.exists():
    raise FileNotFoundError(f'Schema file not found: {SCHEMA_FILE}')

conn = sqlite3.connect(str(SOURCE_DB))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

fok_rows = cur.execute('SELECT * FROM FOK').fetchall()
bank_rows = cur.execute('SELECT * FROM Banktransaction').fetchall()
trn_type_rows = cur.execute('SELECT * FROM trntype').fetchall()
bank_name_rows = cur.execute('SELECT * FROM trnbanknametable').fetchall()

roles = [
    ('admin', 'Administrator', json.dumps(['read_state', 'write_state', 'manage_users', 'view_audit'])),
    ('agent', 'Agent', json.dumps(['read_state', 'write_state'])),
    ('reviewer', 'Reviewer', json.dumps(['read_state', 'write_state', 'approve_changes'])),
    ('viewer', 'Viewer', json.dumps(['read_state']))
]

agents = []
agent_lookup = {}
for row in fok_rows:
    agent_name = normalize_value(row['TransAdmin'])
    if not agent_name:
        continue
    if agent_name not in agent_lookup:
        agent_lookup[agent_name] = len(agent_lookup) + 1
        agents.append((agent_lookup[agent_name], agent_name))

trn_types = []
trn_type_lookup = {}
for row in trn_type_rows:
    source_id = normalize_value(row['ID'])
    trn_type_name = normalize_value(row['TrnType'])
    description = normalize_value(row['Description'])
    if source_id:
        trn_type_lookup[source_id] = trn_type_name
    trn_types.append((source_id, trn_type_name, description))

bank_accounts = []
bank_lookup = {}
for row in bank_name_rows:
    source_id = normalize_value(row['ID'])
    bank_name = normalize_value(row['BankName'])
    if source_id:
        bank_lookup[source_id] = bank_name
    bank_accounts.append((source_id, bank_name))

people = []
for index, row in enumerate(fok_rows, start=1):
    source_id = normalize_value(row['id']) or str(index)
    full_name = normalize_value(row['full_name'])
    first_name = normalize_value(row['first_name'])
    last_name = normalize_value(row['last_name'])
    title = normalize_value(row['title'])
    display_name = full_name or ' '.join(part for part in [first_name, last_name] if part) or title or 'Unknown'
    agent_name = normalize_value(row['TransAdmin'])
    agent_id = agent_lookup.get(agent_name)
    upi_id = normalize_value(row['upi_id']) or normalize_value(row['email_id']) or display_name
    bnktrn_id = normalize_value(row['Bnktrn_ID'])

    people.append((
        index,
        source_id,
        display_name,
        upi_id,
        bnktrn_id,
        str(agent_id) if agent_id is not None else 'NULL',
        sql_string(agent_name) if agent_name else 'NULL',
        'Charity'
    ))


def map_trn_type_tag(raw_tag, fallback_type):
    tag = normalize_value(raw_tag)
    if not tag:
        return normalize_value(fallback_type) or 'Uncategorized'
    names = []
    for token in [part.strip() for part in tag.split(',') if part.strip()]:
        names.append(trn_type_lookup.get(token, token))
    unique_names = []
    for name in names:
        if name not in unique_names:
            unique_names.append(name)
    return ' | '.join(unique_names) if unique_names else (normalize_value(fallback_type) or 'Uncategorized')


transactions = []
for index, row in enumerate(bank_rows, start=1):
    deposit = row['Deposit'] if row['Deposit'] is not None else 0
    withdrawal = row['Withdrawal'] if row['Withdrawal'] is not None else 0
    amount = float(deposit) if deposit != 0 else -float(withdrawal)
    source_id = normalize_value(row['TranID']) or normalize_value(row['SlNo']) or str(index)
    bank_source_id = normalize_value(row['trnbankname'])
    trn_type_tag = normalize_value(row['TrnTypeTag'])
    trn_type_name = map_trn_type_tag(trn_type_tag, row['TranType'])
    transactions.append((
        index,
        source_id,
        normalize_value(row['TranDate'])[:10] if normalize_value(row['TranDate']) else '',
        normalize_value(row['Particulars']) or '',
        amount,
        float(deposit) if deposit is not None else 0,
        float(withdrawal) if withdrawal is not None else 0,
        trn_type_tag,
        trn_type_name,
        normalize_value(row['TrnTypeTag']),
        bank_source_id,
        ''
    ))

bootstrap_people = []
for row in fok_rows:
    full_name = normalize_value(row['full_name'])
    first_name = normalize_value(row['first_name'])
    last_name = normalize_value(row['last_name'])
    title = normalize_value(row['title'])
    display_name = full_name or ' '.join(part for part in [first_name, last_name] if part) or title or 'Unknown'
    agent_name = normalize_value(row['TransAdmin'])
    bootstrap_people.append({
        'id': str(normalize_value(row['id']) or ''),
        'name': display_name,
        'upis': normalize_value(row['upi_id']) or normalize_value(row['email_id']) or display_name,
        'upi_id': normalize_value(row['upi_id']),
        'bnktrn_id': normalize_value(row['Bnktrn_ID']),
        'agent': agent_name,
        'type': 'Charity'
    })

bootstrap_transactions = []
for row in bank_rows:
    deposit = row['Deposit'] if row['Deposit'] is not None else 0
    withdrawal = row['Withdrawal'] if row['Withdrawal'] is not None else 0
    amount = float(deposit) if deposit != 0 else -float(withdrawal)
    trn_type_name = map_trn_type_tag(row['TrnTypeTag'], row['TranType'])
    bank_source_id = normalize_value(row['trnbankname'])
    bootstrap_transactions.append({
        'date': normalize_value(row['TranDate']),
        'description': normalize_value(row['Particulars']),
        'amount': amount,
        'type': trn_type_name,
        'trnTypeTag': normalize_value(row['TrnTypeTag']),
        'trnTypeName': trn_type_name,
        'bankId': bank_source_id,
        'bankName': bank_lookup.get(bank_source_id, bank_source_id or 'Unassigned Bank'),
        'ref': normalize_value(row['TranID']) or normalize_value(row['SlNo']),
        'tran_id': normalize_value(row['TranID']) or normalize_value(row['SlNo'])
    })

bootstrap = {
    'people': bootstrap_people,
    'transactions': bootstrap_transactions,
    'trnTypes': [
        {'id': source_id, 'name': name, 'description': description}
        for source_id, name, description in trn_types
    ],
    'banks': [
        {'id': source_id, 'name': name}
        for source_id, name in bank_accounts
    ]
}

with SCHEMA_FILE.open('r', encoding='utf-8') as fh:
    schema_sql = fh.read().rstrip()

lines = []
lines.append('-- Generated Azure SQL migration script')
lines.append(f'-- Source database: {SOURCE_DB.name}')
lines.append(f'-- Generated at: {datetime.now(timezone.utc).isoformat()}')
lines.append('SET NOCOUNT ON;')
lines.append('BEGIN TRANSACTION;')
lines.append('')
lines.append(schema_sql)
lines.append('')
lines.extend(insert_rows('roles', ['role_code', 'role_title', 'permissions_json'], [
    (sql_string(role_code), sql_string(role_title), sql_string(permissions_json))
    for role_code, role_title, permissions_json in roles
]))
lines.append('')
lines.extend(insert_rows('agents', ['id', 'agent_name'], [
    (str(agent_id), sql_string(agent_name)) for agent_id, agent_name in agents
]))
lines.append('')
lines.extend(insert_rows('bank_accounts', ['source_id', 'bank_name'], [
    (sql_string(source_id), sql_string(bank_name)) for source_id, bank_name in bank_accounts if source_id
]))
lines.append('')
lines.extend(insert_rows('trn_types', ['source_id', 'trn_type_name', 'description'], [
    (sql_string(source_id), sql_string(name), sql_string(description)) for source_id, name, description in trn_types if source_id
]))
lines.append('')
lines.extend(insert_rows('people', ['id', 'source_id', 'display_name', 'upi_id', 'bnktrn_id', 'agent_id', 'agent_name', 'person_type'], [
    (
        str(person_id),
        sql_string(source_id),
        sql_string(display_name),
        sql_string(upi_id),
        sql_string(bnktrn_id),
        agent_id,
        agent_name,
        sql_string(person_type)
    )
    for person_id, source_id, display_name, upi_id, bnktrn_id, agent_id, agent_name, person_type in people
]))
lines.append('')
lines.extend(insert_rows('transactions', ['id', 'source_id', 'tran_date', 'description', 'amount', 'deposit', 'withdrawal', 'trn_type_tag', 'trn_type_name', 'trn_type_source_id', 'bank_account_source_id', 'matched_person_id'], [
    (
        str(transaction_id),
        sql_string(source_id),
        sql_date(tran_date),
        sql_string(description),
        sql_decimal(amount),
        sql_decimal(deposit),
        sql_decimal(withdrawal),
        sql_string(trn_type_tag),
        sql_string(trn_type_name),
        sql_string(trn_type_source_id),
        sql_string(bank_account_source_id),
        'NULL'
    )
    for transaction_id, source_id, tran_date, description, amount, deposit, withdrawal, trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, _matched_person_id in transactions
]))
lines.append('')
lines.extend(insert_rows('app_users', ['id', 'username', 'display_name', 'auth_provider', 'entra_object_id', 'password_hash', 'is_active'], [
    (str(index), sql_string(username), sql_string(display_name), sql_string(auth_provider), 'NULL', sql_string(hash_password(password_hash, username)), '1')
    for index, (username, display_name, auth_provider, password_hash) in enumerate([
        ('admin', 'System Admin', 'local', 'Admin@123'),
        ('agent1', 'Field Agent One', 'local', 'Agent@123'),
        ('review1', 'Finance Reviewer', 'local', 'Review@123'),
        ('viewer1', 'Read Only Viewer', 'local', 'Viewer@123')
    ], start=1)
]))
lines.append('')
lines.extend(insert_rows('user_roles', ['user_id', 'role_code'], [
    (str(index), sql_string(role_code))
    for index, role_code in enumerate(['admin', 'agent', 'reviewer', 'viewer'], start=1)
]))
lines.append('')
lines.extend(insert_rows('app_state', ['id', 'data', 'version'], [
    ('1', sql_string(json.dumps(bootstrap, separators=(',', ':'), ensure_ascii=False)), '1')
]))
lines.append('')
lines.append('COMMIT;')

OUTPUT_FILE.write_text('\n'.join(lines) + '\n', encoding='utf-8')

conn.close()

print(f'Created migration file: {OUTPUT_FILE}')
print(f'People rows: {len(people)}')
print(f'Transaction rows: {len(transactions)}')
print(f'Agents rows: {len(agents)}')
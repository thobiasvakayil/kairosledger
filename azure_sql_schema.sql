IF OBJECT_ID('dbo.roles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.roles (
    role_code NVARCHAR(50) NOT NULL PRIMARY KEY,
    role_title NVARCHAR(100) NOT NULL,
    permissions_json NVARCHAR(MAX) NOT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_roles_created_at DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID('dbo.app_users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_users (
    id INT NOT NULL PRIMARY KEY,
    username NVARCHAR(150) NOT NULL UNIQUE,
    display_name NVARCHAR(200) NULL,
    auth_provider NVARCHAR(50) NOT NULL CONSTRAINT DF_app_users_auth_provider DEFAULT 'local',
    entra_object_id NVARCHAR(100) NULL,
    password_hash NVARCHAR(255) NULL,
    is_active BIT NOT NULL CONSTRAINT DF_app_users_is_active DEFAULT 1,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_app_users_created_at DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID('dbo.user_roles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_roles (
    user_id INT NOT NULL,
    role_code NVARCHAR(50) NOT NULL,
    assigned_at DATETIME2 NOT NULL CONSTRAINT DF_user_roles_assigned_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_user_roles PRIMARY KEY (user_id, role_code),
    CONSTRAINT FK_user_roles_users FOREIGN KEY (user_id) REFERENCES dbo.app_users(id),
    CONSTRAINT FK_user_roles_roles FOREIGN KEY (role_code) REFERENCES dbo.roles(role_code)
  );
END;

IF OBJECT_ID('dbo.agents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agents (
    id INT NOT NULL PRIMARY KEY,
    agent_name NVARCHAR(150) NOT NULL UNIQUE,
    is_active BIT NOT NULL CONSTRAINT DF_agents_is_active DEFAULT 1,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_agents_created_at DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID('dbo.bank_accounts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.bank_accounts (
    source_id NVARCHAR(50) NOT NULL PRIMARY KEY,
    bank_name NVARCHAR(150) NOT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_bank_accounts_created_at DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID('dbo.trn_types', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.trn_types (
    source_id NVARCHAR(50) NOT NULL PRIMARY KEY,
    trn_type_name NVARCHAR(150) NOT NULL,
    description NVARCHAR(400) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_trn_types_created_at DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID('dbo.people', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.people (
    id INT NOT NULL PRIMARY KEY,
    source_id NVARCHAR(50) NULL UNIQUE,
    display_name NVARCHAR(200) NOT NULL,
    upi_id NVARCHAR(200) NULL,
    bnktrn_id NVARCHAR(200) NULL,
    agent_id INT NULL,
    agent_name NVARCHAR(150) NULL,
    person_type NVARCHAR(50) NOT NULL CONSTRAINT DF_people_person_type DEFAULT 'Charity',
    created_at DATETIME2 NOT NULL CONSTRAINT DF_people_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_people_agents FOREIGN KEY (agent_id) REFERENCES dbo.agents(id)
  );
END;

IF OBJECT_ID('dbo.transactions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.transactions (
    id INT NOT NULL PRIMARY KEY,
    source_id NVARCHAR(100) NULL UNIQUE,
    tran_date DATE NULL,
    description NVARCHAR(400) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    deposit DECIMAL(18, 2) NOT NULL CONSTRAINT DF_transactions_deposit DEFAULT 0,
    withdrawal DECIMAL(18, 2) NOT NULL CONSTRAINT DF_transactions_withdrawal DEFAULT 0,
    trn_type_tag NVARCHAR(200) NULL,
    trn_type_name NVARCHAR(150) NULL,
    trn_type_source_id NVARCHAR(50) NULL,
    bank_account_source_id NVARCHAR(50) NULL,
    matched_person_id INT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_transactions_created_at DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_transactions_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_transactions_people FOREIGN KEY (matched_person_id) REFERENCES dbo.people(id),
    CONSTRAINT FK_transactions_trn_types FOREIGN KEY (trn_type_source_id) REFERENCES dbo.trn_types(source_id),
    CONSTRAINT FK_transactions_banks FOREIGN KEY (bank_account_source_id) REFERENCES dbo.bank_accounts(source_id)
  );
END;

IF OBJECT_ID('dbo.audit_log', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.audit_log (
    id BIGINT NOT NULL IDENTITY(1,1) PRIMARY KEY,
    event_time DATETIME2 NOT NULL CONSTRAINT DF_audit_log_event_time DEFAULT SYSUTCDATETIME(),
    actor_user_id INT NULL,
    actor_username NVARCHAR(150) NULL,
    actor_role NVARCHAR(50) NULL,
    action NVARCHAR(100) NOT NULL,
    target_type NVARCHAR(100) NULL,
    target_id NVARCHAR(100) NULL,
    metadata NVARCHAR(MAX) NULL,
    CONSTRAINT FK_audit_log_users FOREIGN KEY (actor_user_id) REFERENCES dbo.app_users(id)
  );
END;

IF OBJECT_ID('dbo.app_state', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_state (
    id INT NOT NULL PRIMARY KEY,
    data NVARCHAR(MAX) NOT NULL,
    version INT NOT NULL CONSTRAINT DF_app_state_version DEFAULT 1,
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_app_state_updated_at DEFAULT SYSUTCDATETIME()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_people_display_name' AND object_id = OBJECT_ID('dbo.people'))
BEGIN
  CREATE INDEX idx_people_display_name ON dbo.people(display_name);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_people_upi_id' AND object_id = OBJECT_ID('dbo.people'))
BEGIN
  CREATE INDEX idx_people_upi_id ON dbo.people(upi_id);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_transactions_tran_date' AND object_id = OBJECT_ID('dbo.transactions'))
BEGIN
  CREATE INDEX idx_transactions_tran_date ON dbo.transactions(tran_date);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_transactions_bank_account_source_id' AND object_id = OBJECT_ID('dbo.transactions'))
BEGIN
  CREATE INDEX idx_transactions_bank_account_source_id ON dbo.transactions(bank_account_source_id);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_transactions_trn_type_source_id' AND object_id = OBJECT_ID('dbo.transactions'))
BEGIN
  CREATE INDEX idx_transactions_trn_type_source_id ON dbo.transactions(trn_type_source_id);
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_event_time' AND object_id = OBJECT_ID('dbo.audit_log'))
BEGIN
  CREATE INDEX idx_audit_log_event_time ON dbo.audit_log(event_time);
END;
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { HASH_VERSION, lessonHash } from './learning-core';

const DATA_DIR = path.join(process.cwd(), 'data');
const configuredPath = process.env.DB_PATH;
const DB_PATH = configuredPath ? path.resolve(process.cwd(), configuredPath) : path.join(DATA_DIR, 'quorum.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initTables(_db);
  }
  return _db;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      report_type TEXT DEFAULT 'general',
      meeting_id TEXT,
      status TEXT DEFAULT 'pending',
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 5,
      source_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      message TEXT NOT NULL,
      system_prompt TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
      response TEXT,
      model TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'general',
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      source_agent TEXT,
      trigger_source TEXT,
      trigger_agent_id TEXT,
      trigger_data TEXT,
      progress TEXT,
      analysis TEXT,
      verification TEXT,
      counsel_summary TEXT,
      final_decision TEXT,
      meeting_id TEXT,
      delegation_level INTEGER DEFAULT 2,
      review_notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS directives (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      assignees TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      direction TEXT,
      entry_price REAL,
      exit_price REAL,
      pnl REAL,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_id);
    CREATE INDEX IF NOT EXISTS idx_queue_status ON chat_queue(status);
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT NOT NULL,
      agent_id TEXT,
      schedule_type TEXT DEFAULT 'interval',
      schedule_value TEXT NOT NULL,
      prompt TEXT NOT NULL,
      channel TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled, next_run);
    -- agent_configs: 에이전트 정의 원천(페르소나/skills/메타). 전역 1벌. JSON 컬럼은 TEXT 직렬화.
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      legacy_id TEXT,
      number TEXT,
      name TEXT,
      display_ko TEXT,
      display_en TEXT,
      department TEXT,
      tier TEXT,
      report_to TEXT,
      llm TEXT,
      role TEXT,
      descr TEXT,
      color TEXT,
      emoji TEXT,
      floor INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      persona TEXT,
      core_role TEXT,
      skills TEXT DEFAULT '[]',
      success_metrics TEXT DEFAULT '[]',
      critical_rules TEXT DEFAULT '[]',
      topics TEXT DEFAULT '[]',
      relationships TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
    -- 회의(background runner) — Supabase/Postgres와 동일 스키마. INTEGER PK라 lastInsertRowid가 곧 id.
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT,
      topic_type TEXT,
      agenda TEXT,
      participants TEXT DEFAULT '[]',
      agent_order TEXT DEFAULT '[]',
      status TEXT DEFAULT 'running',
      next_index INTEGER DEFAULT 0,
      next_seq INTEGER DEFAULT 1,
      retry_count INTEGER DEFAULT 0,
      version INTEGER DEFAULT 0,
      summary TEXT,
      directive_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meeting_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      slot INTEGER,
      type TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      number TEXT,
      floor TEXT,
      role TEXT,
      message TEXT,
      summary TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mm_meeting ON meeting_messages(meeting_id, seq);
    -- slot 멱등키: 같은 회의에서 동일 slot 재삽입을 UNIQUE 위반으로 차단(dbInsertIdempotent가 null 반환).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_slot ON meeting_messages(meeting_id, slot) WHERE slot IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
  `);
  // Migrations for existing databases
  const migrate = (sql: string) => { try { db.exec(sql); } catch {} };
  migrate('ALTER TABLE decisions ADD COLUMN description TEXT');
  migrate('ALTER TABLE decisions ADD COLUMN priority TEXT DEFAULT "normal"');
  migrate('ALTER TABLE decisions ADD COLUMN trigger_source TEXT');
  migrate('ALTER TABLE decisions ADD COLUMN trigger_agent_id TEXT');
  migrate('ALTER TABLE decisions ADD COLUMN trigger_data TEXT');
  migrate('ALTER TABLE decisions ADD COLUMN progress TEXT');
  // Supabase decisions에는 있으나 sqlite에 누락됐던 컬럼 — 회의↔지시 동기화(meeting_id 쓰기)가
  // sqlite에서 'no such column'으로 통째 실패하던 드리프트 수정.
  migrate('ALTER TABLE decisions ADD COLUMN meeting_id TEXT');
  migrate('ALTER TABLE decisions ADD COLUMN delegation_level INTEGER DEFAULT 2');
  migrate('ALTER TABLE decisions ADD COLUMN review_notes TEXT');
  migrate('ALTER TABLE chat_queue ADD COLUMN system_prompt TEXT');
  migrate('ALTER TABLE chat_queue ADD COLUMN metadata TEXT');
  migrate('ALTER TABLE reports ADD COLUMN directive_id TEXT');
  // directive·타입별 보고서 1건 보장 — upsert race 시 중복 INSERT 차단(upsertDirectiveReport가 update로 수렴).
  // (directive_id, report_type) 조합 — 같은 directive에 일반/지시 보고서가 공존해도 충돌하지 않게.
  // directive_id-only 구버전 인덱스는 제거(같은 directive에 다른 타입 보고서를 막던 문제).
  migrate('DROP INDEX IF EXISTS idx_reports_directive_id');
  migrate('DROP INDEX IF EXISTS idx_reports_directive_id_unique');
  migrate('CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_directive_type ON reports(directive_id, report_type) WHERE directive_id IS NOT NULL');

  // ── 학습 루프(Phase A) 스키마 ──
  // agent_memory를 canonical 메모리로 확장(반복 교훈 1 row 수렴). 기존 row는 backfill 후 NOT NULL 적용.
  migrate('ALTER TABLE agent_memory ADD COLUMN normalized_hash TEXT');
  migrate('ALTER TABLE agent_memory ADD COLUMN hash_version INTEGER');
  migrate('ALTER TABLE agent_memory ADD COLUMN current_type TEXT');
  migrate('ALTER TABLE agent_memory ADD COLUMN status TEXT');
  migrate('ALTER TABLE agent_memory ADD COLUMN confidence REAL');
  migrate('ALTER TABLE agent_memory ADD COLUMN evidence_count INTEGER DEFAULT 0');
  migrate('ALTER TABLE agent_memory ADD COLUMN last_seen_at TEXT');
  migrate('ALTER TABLE agent_memory ADD COLUMN hash_collision_group TEXT'); // reserved/deprecated(#52): SHA 충돌 split 제거(#44) 후 미사용, 호환 위해 컬럼 유지
  // legacy backfill: current_type=memory_type, status=active, last_seen_at=created_at (normalized_hash는 db 레이어에서 채움)
  migrate("UPDATE agent_memory SET current_type = memory_type WHERE current_type IS NULL");
  migrate("UPDATE agent_memory SET status = 'active' WHERE status IS NULL");
  migrate('UPDATE agent_memory SET last_seen_at = created_at WHERE last_seen_at IS NULL');
  migrate('UPDATE agent_memory SET evidence_count = 0 WHERE evidence_count IS NULL');
  // canonical unique: normalized_hash 채워진 row만(backfill 전 NULL row는 제외 — NULL 중복 회피 위해 partial).
  migrate('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_canon ON agent_memory(agent_id, normalized_hash) WHERE normalized_hash IS NOT NULL');
  migrate('CREATE INDEX IF NOT EXISTS idx_memory_retrieve ON agent_memory(agent_id, status, current_type, importance DESC, last_seen_at DESC)');
  migrate('CREATE INDEX IF NOT EXISTS idx_memory_collision ON agent_memory(hash_collision_group)');
  // #60: round별 reflect 경계(reserve 시 확정) — followup 후 resume도 해당 round 범위만 학습.
  migrate('ALTER TABLE meeting_reflections ADD COLUMN from_seq INTEGER');
  migrate('ALTER TABLE meeting_reflections ADD COLUMN to_seq INTEGER');

  db.exec(`
    -- span 발생: 같은 (round, agent, evidence_seq, excerpt span)당 1 row. 불변 원문 좌표 → paraphrase 안정.
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      evidence_seq INTEGER NOT NULL,
      excerpt TEXT,
      excerpt_start INTEGER NOT NULL,
      excerpt_end INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_span ON memory_evidence(round_id, agent_id, evidence_seq, excerpt_start, excerpt_end);
    CREATE INDEX IF NOT EXISTS idx_evidence_round ON memory_evidence(round_id);

    -- span↔교훈: 한 span에서 여러 교훈 허용. lesson_fingerprint가 link identity.
    CREATE TABLE IF NOT EXISTS memory_evidence_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id INTEGER NOT NULL REFERENCES memory_evidence(id) ON DELETE CASCADE,
      memory_id INTEGER REFERENCES agent_memory(id),
      lesson_index INTEGER,
      lesson_fingerprint TEXT NOT NULL,
      importance INTEGER,
      content TEXT,
      requested_hash TEXT,
      canonical_hash TEXT,
      hash_version INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_link_fingerprint ON memory_evidence_links(evidence_id, lesson_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_link_memory ON memory_evidence_links(memory_id);
    CREATE INDEX IF NOT EXISTS idx_link_evidence_memory ON memory_evidence_links(evidence_id, memory_id);

    -- REFLECT 마커: round 단위 lease claim + 재시도 한도 + terminal 상태.
    CREATE TABLE IF NOT EXISTS meeting_reflections (
      round_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      hash_version INTEGER,
      owner_id TEXT,
      lease_until TEXT,
      updated_at TEXT,
      attempt_count INTEGER DEFAULT 0,
      next_retry_at TEXT,
      lesson_count INTEGER,
      error TEXT,
      from_seq INTEGER,
      to_seq INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // legacy normalized_hash/hash_version backfill(#6): SQL로 정규화 불가 → JS로 계산해 채움.
  // 정규화-동일 중복은 partial unique 위반 → 그 row는 skip(첫 row만 canonical).
  backfillMemoryHashes(db);

  seedSchedules(db);
  seedDemoData(db);

}

function backfillMemoryHashes(db: Database.Database) {
  const rows = db.prepare("SELECT id, content FROM agent_memory WHERE normalized_hash IS NULL").all() as Array<{ id: number; content: string }>;
  const upd = db.prepare("UPDATE agent_memory SET normalized_hash=?, hash_version=? WHERE id=?");
  const mergeDup = db.prepare("UPDATE agent_memory SET status='merged' WHERE id=?");
  for (const r of rows) {
    try { upd.run(lessonHash(HASH_VERSION, r.content), HASH_VERSION, r.id); }
    catch {
      // (agent_id, normalized_hash) 중복 = legacy duplicate → merged로 전이(retrieve의 active 필터에서 제외, #63). supabase backfill과 동치.
      mergeDup.run(r.id);
    }
  }
}




function seedDemoData(db: Database.Database) {
  const count = (db.prepare('SELECT COUNT(*) as c FROM reports').get() as { c: number }).c;
  if (count > 0) return;

  const ago = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();

  // Reports
  const reportStmt = db.prepare(
    'INSERT INTO reports (id, agent_id, title, content, report_type, status, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)'
  );
  reportStmt.run('lead', 'Company Environment Analysis Complete',
    'System check complete. 30 agents initialized. LLM provider configured and operational. All departments reporting ready status. Recommendation: Begin with a strategy directive to test the full pipeline.',
    'general', 'reviewed', ago(2));
  reportStmt.run('research', 'GitHub Trending: 5 High-Relevance AI Repositories',
    '1. llm-agents-framework (2.1k stars) - Multi-agent orchestration\n2. local-ai-stack (1.8k stars) - Self-hosted LLM infrastructure\n3. agent-memory (1.2k stars) - Persistent memory for AI agents\n4. tool-calling-bench (900 stars) - Benchmarks for tool-use\n5. rag-evaluation (750 stars) - RAG quality metrics\n\nRecommendation: agent-memory aligns with our architecture.',
    'research', 'pending', ago(1));
  reportStmt.run('risk', 'Risk Assessment: New Investment Proposal',
    'Target: EdgeAI Solutions Series A ($15M)\n\nRisk Factors:\n- Market: AI hardware commoditization risk (Medium)\n- Technical: Proprietary chip dependency (High)\n- Financial: 18-month runway at current burn (Medium)\n\nVerdict: Proceed with caution. Recommend due diligence on chip supplier contracts.',
    'analysis', 'pending', ago(3));
  reportStmt.run('monitoring', 'Daily Service Health Check',
    'All systems operational. API Response Time: 142ms avg. Uptime: 99.97% (30-day). Error Rate: 0.02%. Database: 45% capacity. No critical alerts.',
    'health_check', 'reviewed', ago(4));
  reportStmt.run('pr', 'Weekly Social Media Performance Report',
    'Social: Impressions 12.4K (+23% WoW), Engagement 4.2%, Top Post: "30 AI agents, one founder" (847 likes), New Followers: +38. Recommendation: Double down on builder narrative content.',
    'general', 'pending', ago(5));

  // Decisions
  const decStmt = db.prepare(
    'INSERT INTO decisions (id, title, description, type, status, priority, source_agent, trigger_source, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  decStmt.run('European Market Expansion Strategy',
    'Evaluate potential for AI consulting services in EU market. Focus on London and Berlin offices.',
    'strategy', 'in_progress', 'high', 'lead', 'directive', ago(6), ago(1));
  decStmt.run('Open Source Release Readiness',
    'Final checklist for public repository launch. Code audit, documentation review, license compliance.',
    'general', 'completed', 'critical', 'strategy', 'manual', ago(24), ago(2));
  decStmt.run('Q1 Budget Reallocation',
    'Redistribute unused marketing budget to R&D infrastructure. $45K available.',
    'financial', 'pending', 'normal', 'finance', 'agent', ago(8), ago(8));

  // Agent memory (current_type/status/last_seen_at + normalized_hash로 canonical-ready)
  const memStmt = db.prepare(
    "INSERT INTO agent_memory (agent_id, memory_type, content, importance, created_at, current_type, status, last_seen_at, evidence_count, normalized_hash, hash_version) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)"
  );
  const seedMem = (agent: string, type: string, content: string, imp: number, when: string) =>
    memStmt.run(agent, type, content, imp, when, type, when, lessonHash(HASH_VERSION, content), HASH_VERSION);
  seedMem('lead', 'insight', 'Chairman prefers concise 3-line summaries with actionable items.', 8, ago(24));
  seedMem('research', 'observation', 'GitHub trending repos with 1K+ weekly stars have 70% chance of sustained growth.', 6, ago(12));
  seedMem('risk', 'lesson', 'Always verify financial projections with at least 2 independent data sources.', 9, ago(48));
}


function seedSchedules(db: Database.Database) {
  const count = (db.prepare('SELECT COUNT(*) as c FROM schedules').get() as { c: number }).c;
  if (count > 0) return;
  const seeds = [
    { name: 'Market Morning Brief', agent_id: 'quant', schedule_type: 'daily', schedule_value: '09:00', prompt: 'Analyze todays market conditions and provide a brief summary of key indicators, trends, and recommendations.', channel: '' },
    { name: 'Security Audit', agent_id: 'security', schedule_type: 'daily', schedule_value: '22:00', prompt: 'Run daily security check. Review access logs, check for vulnerabilities, and report any anomalies.', channel: '' },
    { name: 'News Scan', agent_id: 'research', schedule_type: 'daily', schedule_value: '08:00', prompt: 'Scan latest industry news and trends. Summarize key developments relevant to our business.', channel: '' },
  ];
  const stmt = db.prepare('INSERT INTO schedules (id, name, agent_id, schedule_type, schedule_value, prompt, channel) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)');
  for (const s of seeds) {
    stmt.run(s.name, s.agent_id, s.schedule_type, s.schedule_value, s.prompt, s.channel);
  }
}
export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

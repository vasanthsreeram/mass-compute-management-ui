export type Role = "user" | "admin";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  role: Role;
  credit_cents: number;
  spent_cents: number;
  allowed_gpus: string;
  max_concurrent: number;
  created_at: string;
};

export type PublicUser = {
  id: string;
  email: string;
  role: Role;
  credit_cents: number;
  spent_cents: number;
  allowed_gpus: string[];
  max_concurrent: number;
  created_at: string;
};

export type InstanceRow = {
  id: string;
  mc_uuid: string | null;
  user_id: string;
  name: string;
  product_name: string;
  region_name: string;
  price_cents_per_hour: number;
  status: string;
  ip: string | null;
  username: string | null;
  password_enc: string | null;
  image_id: number | null;
  launched_at: string;
  terminated_at: string | null;
  last_metered_at: string;
};

export function publicUser(row: UserRow): PublicUser {
  let gpus: string[] = [];
  try {
    gpus = JSON.parse(row.allowed_gpus) as string[];
  } catch {
    gpus = [];
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    credit_cents: row.credit_cents,
    spent_cents: row.spent_cents,
    allowed_gpus: gpus,
    max_concurrent: row.max_concurrent,
    created_at: row.created_at,
  };
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function userCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertUser(db: D1Database, user: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, salt, role, credit_cents, spent_cents, allowed_gpus, max_concurrent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.email,
      user.password_hash,
      user.salt,
      user.role,
      user.credit_cents,
      user.spent_cents,
      user.allowed_gpus,
      user.max_concurrent,
      user.created_at,
    )
    .run();
}

export async function audit(db: D1Database, userId: string | null, action: string, detail: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, action, JSON.stringify(detail), new Date().toISOString())
    .run();
}

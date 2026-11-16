// SQL builders for role management. Pure functions: a form state goes in, the
// statements that realize it come out. The dialogs show these statements before
// running them, so what the user reviews is exactly what executes.
import type { RoleInfo } from "./api";
import { quoteIdentAlways as qi, quoteLiteral } from "./pgFormat";

export interface RoleForm {
  name: string;
  /** Empty = leave the password alone (edit) / create without one. */
  password: string;
  canLogin: boolean;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  inherit: boolean;
  /** -1 = unlimited. */
  connectionLimit: number;
  /** A timestamp Postgres accepts, or empty for no expiry. */
  validUntil: string;
  memberOf: string[];
  comment: string;
}

export function emptyRoleForm(): RoleForm {
  return {
    name: "",
    password: "",
    canLogin: true,
    superuser: false,
    createDb: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    inherit: true,
    connectionLimit: -1,
    validUntil: "",
    memberOf: [],
    comment: "",
  };
}

export function roleToForm(role: RoleInfo): RoleForm {
  return {
    name: role.name,
    password: "",
    canLogin: role.can_login,
    superuser: role.is_superuser,
    createDb: role.create_db,
    createRole: role.create_role,
    replication: role.replication,
    bypassRls: role.bypass_rls,
    inherit: role.inherit,
    connectionLimit: role.connection_limit,
    // "infinity" is how Postgres prints a password that never expires.
    validUntil: role.valid_until && role.valid_until !== "infinity" ? role.valid_until : "",
    memberOf: [...role.member_of],
    comment: role.comment ?? "",
  };
}

const flag = (on: boolean, word: string) => (on ? word : `NO${word}`);

/// The attribute clauses of CREATE/ALTER ROLE that differ from `base` (all of them
/// when there is no base).
function attributeClauses(form: RoleForm, base: RoleForm | null): string[] {
  const out: string[] = [];
  const changed = <K extends keyof RoleForm>(key: K) => !base || base[key] !== form[key];
  if (changed("canLogin")) out.push(flag(form.canLogin, "LOGIN"));
  if (changed("superuser")) out.push(flag(form.superuser, "SUPERUSER"));
  if (changed("createDb")) out.push(flag(form.createDb, "CREATEDB"));
  if (changed("createRole")) out.push(flag(form.createRole, "CREATEROLE"));
  if (changed("replication")) out.push(flag(form.replication, "REPLICATION"));
  if (changed("bypassRls")) out.push(flag(form.bypassRls, "BYPASSRLS"));
  if (changed("inherit")) out.push(flag(form.inherit, "INHERIT"));
  if (changed("connectionLimit")) out.push(`CONNECTION LIMIT ${Math.trunc(form.connectionLimit)}`);
  if (changed("validUntil")) {
    out.push(`VALID UNTIL ${quoteLiteral(form.validUntil.trim() || "infinity")}`);
  }
  if (form.password) out.push(`PASSWORD ${quoteLiteral(form.password)}`);
  return out;
}

/// Statements that create a role from the form.
export function createRoleSql(form: RoleForm): string[] {
  const name = qi(form.name.trim());
  // A new role's defaults are NOLOGIN … INHERIT, unlimited, no expiry; spell out only
  // what differs so the statement reads like one a person would write.
  const defaults: RoleForm = { ...emptyRoleForm(), canLogin: false };
  const clauses = attributeClauses(form, defaults);
  const out = [`CREATE ROLE ${name}${clauses.length ? ` WITH ${clauses.join(" ")}` : ""}`];
  for (const group of form.memberOf) out.push(`GRANT ${qi(group)} TO ${name}`);
  if (form.comment.trim()) {
    out.push(`COMMENT ON ROLE ${name} IS ${quoteLiteral(form.comment.trim())}`);
  }
  return out;
}

/// Statements that bring an existing role from `before` to `after`. Empty when
/// nothing changed.
export function alterRoleSql(before: RoleForm, after: RoleForm): string[] {
  const out: string[] = [];
  const oldName = qi(before.name);
  const newName = qi(after.name.trim());
  // Rename first so every later statement can use the new name.
  if (after.name.trim() !== before.name) out.push(`ALTER ROLE ${oldName} RENAME TO ${newName}`);
  const clauses = attributeClauses(after, before);
  if (clauses.length) out.push(`ALTER ROLE ${newName} WITH ${clauses.join(" ")}`);
  for (const group of after.memberOf) {
    if (!before.memberOf.includes(group)) out.push(`GRANT ${qi(group)} TO ${newName}`);
  }
  for (const group of before.memberOf) {
    if (!after.memberOf.includes(group)) out.push(`REVOKE ${qi(group)} FROM ${newName}`);
  }
  if (after.comment.trim() !== before.comment.trim()) {
    const value = after.comment.trim() ? quoteLiteral(after.comment.trim()) : "NULL";
    out.push(`COMMENT ON ROLE ${newName} IS ${value}`);
  }
  return out;
}

export function dropRoleSql(name: string, dropOwned: boolean): string[] {
  const role = qi(name);
  // DROP OWNED also revokes the role's privileges in the current database, which is
  // what usually blocks a plain DROP ROLE.
  return dropOwned ? [`DROP OWNED BY ${role}`, `DROP ROLE ${role}`] : [`DROP ROLE ${role}`];
}

/// Replaces password literals so a statement can be displayed.
export function maskPasswords(statement: string): string {
  return statement.replace(/PASSWORD E?'(?:[^']|'')*'/g, "PASSWORD '••••••'");
}

// ---- Privileges ----

export type GrantScope =
  | "database"
  | "schema"
  | "all_tables"
  | "all_sequences"
  | "all_functions"
  | "table";

export const SCOPE_LABELS: Record<GrantScope, string> = {
  database: "Database",
  schema: "Schema",
  all_tables: "All tables in schema",
  all_sequences: "All sequences in schema",
  all_functions: "All functions in schema",
  table: "A single table",
};

export const SCOPE_PRIVILEGES: Record<GrantScope, string[]> = {
  database: ["CONNECT", "CREATE", "TEMPORARY"],
  schema: ["USAGE", "CREATE"],
  all_tables: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  all_sequences: ["USAGE", "SELECT", "UPDATE"],
  all_functions: ["EXECUTE"],
  table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
};

export interface GrantRequest {
  role: string;
  scope: GrantScope;
  privileges: string[];
  database: string;
  schema: string;
  /** Only for the "table" scope. */
  table: string;
  /** Also cover objects created later (ALTER DEFAULT PRIVILEGES). Schema-wide scopes only. */
  future: boolean;
}

function grantTarget(req: GrantRequest): string {
  switch (req.scope) {
    case "database":
      return `DATABASE ${qi(req.database)}`;
    case "schema":
      return `SCHEMA ${qi(req.schema)}`;
    case "all_tables":
      return `ALL TABLES IN SCHEMA ${qi(req.schema)}`;
    case "all_sequences":
      return `ALL SEQUENCES IN SCHEMA ${qi(req.schema)}`;
    case "all_functions":
      return `ALL FUNCTIONS IN SCHEMA ${qi(req.schema)}`;
    case "table":
      return `TABLE ${qi(req.schema)}.${qi(req.table)}`;
  }
}

const FUTURE_KIND: Partial<Record<GrantScope, string>> = {
  all_tables: "TABLES",
  all_sequences: "SEQUENCES",
  all_functions: "FUNCTIONS",
};

export function grantSql(req: GrantRequest): string[] {
  if (req.privileges.length === 0) return [];
  const privs = req.privileges.join(", ");
  const role = qi(req.role);
  const out = [`GRANT ${privs} ON ${grantTarget(req)} TO ${role}`];
  const futureKind = FUTURE_KIND[req.scope];
  if (req.future && futureKind) {
    // Applies to objects the CURRENT role creates in this schema from now on.
    out.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${qi(req.schema)} GRANT ${privs} ON ${futureKind} TO ${role}`,
    );
  }
  return out;
}

export type GrantPreset = "read_only" | "read_write";

/// The usual bundles for an application role on one schema.
export function presetSql(preset: GrantPreset, role: string, schema: string, future: boolean): string[] {
  const base = { role, schema, database: "", table: "", future };
  const tables =
    preset === "read_only" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const sequences = preset === "read_only" ? ["SELECT"] : ["USAGE", "SELECT", "UPDATE"];
  return [
    ...grantSql({ ...base, scope: "schema", privileges: ["USAGE"] }),
    ...grantSql({ ...base, scope: "all_tables", privileges: tables }),
    ...grantSql({ ...base, scope: "all_sequences", privileges: sequences }),
  ];
}

/// Revokes every privilege a role holds on one object, as listed by `get_role_grants`.
export function revokeSql(
  role: string,
  grant: { object_type: string; schema?: string | null; name: string },
): string {
  const who = qi(role);
  switch (grant.object_type) {
    case "database":
      return `REVOKE ALL ON DATABASE ${qi(grant.name)} FROM ${who}`;
    case "schema":
      return `REVOKE ALL ON SCHEMA ${qi(grant.name)} FROM ${who}`;
    case "sequence":
      return `REVOKE ALL ON SEQUENCE ${qi(grant.schema ?? "public")}.${qi(grant.name)} FROM ${who}`;
    case "function": {
      // `name` is "fn(argtypes)"; only the function name part is an identifier.
      const open = grant.name.indexOf("(");
      const fn = open === -1 ? grant.name : grant.name.slice(0, open);
      const args = open === -1 ? "()" : grant.name.slice(open);
      // ROUTINE covers procedures too, which the grants list doesn't tell apart.
      return `REVOKE ALL ON ROUTINE ${qi(grant.schema ?? "public")}.${qi(fn)}${args} FROM ${who}`;
    }
    default:
      return `REVOKE ALL ON TABLE ${qi(grant.schema ?? "public")}.${qi(grant.name)} FROM ${who}`;
  }
}

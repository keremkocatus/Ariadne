//! Schema cache: Ariadne's performance core. The SINGLE data source for
//! autocomplete and the object explorer. The live DB is only queried on connect and
//! on refresh.
//!
//! The cache is an **immutable snapshot**: a refresh builds a new SchemaCache and
//! swaps it in atomically via `ArcSwap`, so readers (completion) never wait on a lock.

pub mod catalog;
pub mod snapshot;

pub use snapshot::SchemaSnapshot;

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use smallvec::SmallVec;

pub type TableId = u32; // pg_class.oid
pub type FunctionId = u32; // pg_proc.oid
pub type ColIdx = usize; // index into Table.columns

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelKind {
    Table,
    View,
    MatView,
    Foreign,
    Partitioned,
    Sequence,
}

impl RelKind {
    pub fn from_pg(relkind: i8) -> Option<Self> {
        match relkind as u8 {
            b'r' => Some(Self::Table),
            b'v' => Some(Self::View),
            b'm' => Some(Self::MatView),
            b'f' => Some(Self::Foreign),
            b'p' => Some(Self::Partitioned),
            b'S' => Some(Self::Sequence),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FnKind {
    Function,
    Procedure,
    Aggregate,
    Window,
}

impl FnKind {
    pub fn from_pg(prokind: i8) -> Self {
        match prokind as u8 {
            b'p' => Self::Procedure,
            b'a' => Self::Aggregate,
            b'w' => Self::Window,
            _ => Self::Function,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgMode {
    In,
    Out,
    InOut,
    Variadic,
    /// An arg of a TABLE(...)-returning function. Modeled from the catalog; treated
    /// like `In` for now.
    #[allow(dead_code)]
    Table,
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    pub type_name: String, // format_type() output: "int4", "varchar(255)"
    pub not_null: bool,
    // Filled from the catalog; read by the object-detail panel / inline edit.
    #[allow(dead_code)]
    pub has_default: bool,
    #[allow(dead_code)]
    pub comment: Option<String>,
    pub attnum: i16, // internal: for PK/FK attnum resolution
}

#[derive(Debug, Clone)]
pub struct Table {
    pub id: TableId,
    pub schema: String,
    pub name: String,
    pub kind: RelKind,
    pub columns: Vec<Column>, // in attnum order
    pub primary_key: Vec<ColIdx>,
    pub comment: Option<String>,
    pub estimated_rows: i64, // pg_class.reltuples
}

impl Table {
    /// attnum → columns index (may have gaps because dropped columns are removed).
    fn attnum_index(&self) -> HashMap<i16, ColIdx> {
        self.columns
            .iter()
            .enumerate()
            .map(|(i, c)| (c.attnum, i))
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct FkEdge {
    pub from_table: TableId,
    pub from_cols: Vec<ColIdx>,
    pub to_table: TableId,
    pub to_cols: Vec<ColIdx>,
    pub constraint_name: String,
}

#[derive(Debug, Clone)]
pub struct FnArg {
    pub name: Option<String>,
    pub type_name: String,
    pub mode: ArgMode,
    /// An arg with a DEFAULT (may be omitted at the call site).
    #[allow(dead_code)]
    pub has_default: bool,
}

#[derive(Debug, Clone)]
pub struct Function {
    pub id: FunctionId,
    pub schema: String,
    pub name: String,
    pub args: Vec<FnArg>,
    pub return_type: String,
    pub kind: FnKind,
    /// Whether the return type is `trigger` — for the "trigger function" filter in
    /// the explorer. Independent of `kind` (trigger fns have prokind='f').
    pub is_trigger: bool,
    pub comment: Option<String>,
}

impl Function {
    /// "get_user_orders(user_id int4) → setof orders" — the completion/peek label.
    pub fn signature(&self) -> String {
        let args = self
            .args
            .iter()
            .filter(|a| matches!(a.mode, ArgMode::In | ArgMode::InOut | ArgMode::Variadic))
            .map(|a| match &a.name {
                Some(n) => format!("{n} {}", a.type_name),
                None => a.type_name.clone(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("{}({}) → {}", self.name, args, self.return_type)
    }
}

#[derive(Debug, Clone)]
pub struct SchemaInfo {
    pub name: String,
    /// From the catalog; for showing the schema owner in the explorer.
    #[allow(dead_code)]
    pub owner: String,
    pub is_system: bool,
}

/// Immutable schema snapshot + fast lookup indexes.
pub struct SchemaCache {
    pub fetched_at: DateTime<Utc>,
    pub server_version: String,
    pub search_path: Vec<String>,
    pub schemas: Vec<SchemaInfo>,

    pub tables: HashMap<TableId, Table>,
    pub functions: HashMap<FunctionId, Function>,

    // ---- Lookup indexes (built once after fetch) ----
    pub table_by_qualified: HashMap<String, TableId>, // "schema.name" (lc) → id
    pub table_by_name: HashMap<String, SmallVec<[TableId; 2]>>, // "name" (lc) → ids
    pub function_by_name: HashMap<String, SmallVec<[FunctionId; 2]>>,
    pub fk_adjacency: HashMap<TableId, Vec<FkEdge>>, // bidirectional
}

impl SchemaCache {
    /// Builds the cache from raw catalog data: computes the indexes and the FK graph.
    pub fn build(
        fetched_at: DateTime<Utc>,
        server_version: String,
        search_path: Vec<String>,
        schemas: Vec<SchemaInfo>,
        tables: Vec<Table>,
        functions: Vec<Function>,
        fks: Vec<FkEdge>,
    ) -> Self {
        let mut table_by_qualified = HashMap::with_capacity(tables.len());
        let mut table_by_name: HashMap<String, SmallVec<[TableId; 2]>> = HashMap::new();

        for t in &tables {
            table_by_qualified.insert(format!("{}.{}", t.schema, t.name).to_lowercase(), t.id);
            table_by_name
                .entry(t.name.to_lowercase())
                .or_default()
                .push(t.id);
        }

        let mut function_by_name: HashMap<String, SmallVec<[FunctionId; 2]>> = HashMap::new();
        for f in &functions {
            function_by_name
                .entry(f.name.to_lowercase())
                .or_default()
                .push(f.id);
        }

        // Bidirectional FK graph: both outgoing and incoming FKs are visible from a table.
        let mut fk_adjacency: HashMap<TableId, Vec<FkEdge>> = HashMap::new();
        for edge in fks {
            fk_adjacency
                .entry(edge.from_table)
                .or_default()
                .push(edge.clone());
            if edge.to_table != edge.from_table {
                fk_adjacency.entry(edge.to_table).or_default().push(edge);
            }
        }

        let tables = tables.into_iter().map(|t| (t.id, t)).collect();
        let functions = functions.into_iter().map(|f| (f.id, f)).collect();

        Self {
            fetched_at,
            server_version,
            search_path,
            schemas,
            tables,
            functions,
            table_by_qualified,
            table_by_name,
            function_by_name,
            fk_adjacency,
        }
    }

    /// An empty cache (connection established but the fetch hasn't finished).
    pub fn empty(server_version: String) -> Self {
        Self::build(
            Utc::now(),
            server_version,
            vec!["public".to_string()],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
    }

    /// A table's estimated row count (pg_class.reltuples). Used for the destructive
    /// guard's "~2.1M rows affected" message. `name` may be bare ("orders") or
    /// schema-qualified ("public.orders"); bare names resolve by search_path priority.
    pub fn table_estimated_rows(&self, name: &str) -> Option<i64> {
        let id = if let Some((schema, tbl)) = name.split_once('.') {
            self.table_by_qualified
                .get(&format!("{schema}.{tbl}").to_lowercase())
                .copied()
        } else {
            self.table_by_name
                .get(&name.to_lowercase())
                .and_then(|ids| {
                    ids.iter()
                        .min_by_key(|id| {
                            self.tables
                                .get(id)
                                .and_then(|t| self.search_path.iter().position(|s| s == &t.schema))
                                .unwrap_or(usize::MAX)
                        })
                        .copied()
                })
        };
        // reltuples = -1 → never analyzed (unknown); don't show an estimate.
        id.and_then(|id| self.tables.get(&id))
            .map(|t| t.estimated_rows)
            .filter(|&n| n >= 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tbl(id: TableId, schema: &str, name: &str, rows: i64) -> Table {
        Table {
            id,
            schema: schema.into(),
            name: name.into(),
            kind: RelKind::Table,
            columns: Vec::new(),
            primary_key: Vec::new(),
            comment: None,
            estimated_rows: rows,
        }
    }

    fn cache(tables: Vec<Table>) -> SchemaCache {
        SchemaCache::build(
            Utc::now(),
            "17".into(),
            vec!["public".into()],
            Vec::new(),
            tables,
            Vec::new(),
            Vec::new(),
        )
    }

    #[test]
    fn estimated_rows_by_bare_name_uses_search_path() {
        // Same name in two schemas; public is on the search_path → public's is chosen.
        let c = cache(vec![
            tbl(1, "public", "orders", 5000),
            tbl(2, "archive", "orders", 9),
        ]);
        assert_eq!(c.table_estimated_rows("orders"), Some(5000));
    }

    #[test]
    fn estimated_rows_qualified_and_unknown() {
        let c = cache(vec![
            tbl(1, "archive", "orders", 42),
            tbl(2, "public", "t", -1),
        ]);
        assert_eq!(c.table_estimated_rows("archive.orders"), Some(42));
        // -1 (not analyzed) → None; missing table → None.
        assert_eq!(c.table_estimated_rows("t"), None);
        assert_eq!(c.table_estimated_rows("nope"), None);
    }
}

//! Şema cache: Ariadne'nin performans kalbi (design 03). Autocomplete ve object
//! explorer'ın TEK veri kaynağı. Canlı DB'ye sadece kurulurken/yenilenirken gidilir.
//!
//! Cache **immutable snapshot**'tır: refresh yeni bir SchemaCache kurup `ArcSwap`
//! ile atomik değiştirir; okuyanlar (completion) lock beklemez (design 01 §3, 03 §5).

pub mod catalog;
pub mod snapshot;

pub use snapshot::SchemaSnapshot;

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use smallvec::SmallVec;

pub type TableId = u32; // pg_class.oid
pub type FunctionId = u32; // pg_proc.oid
pub type ColIdx = usize; // Table.columns içindeki indeks

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
    /// TABLE(...) dönüşlü fonksiyon arg'ı. Katalogdan modellenir; signature help
    /// bunu Phase 1'de ayrı gösterecek. Şimdilik `In` gibi ele alınır.
    #[allow(dead_code)]
    Table,
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    pub type_name: String, // format_type() çıktısı: "int4", "varchar(255)"
    pub not_null: bool,
    // Katalogdan doldurulur; object-detail paneli / inline-edit (Phase 1) okuyacak.
    #[allow(dead_code)]
    pub has_default: bool,
    #[allow(dead_code)]
    pub comment: Option<String>,
    pub attnum: i16, // dahili: PK/FK attnum çözümü için
}

#[derive(Debug, Clone)]
pub struct Table {
    pub id: TableId,
    pub schema: String,
    pub name: String,
    pub kind: RelKind,
    pub columns: Vec<Column>, // attnum sırasında
    pub primary_key: Vec<ColIdx>,
    pub comment: Option<String>,
    pub estimated_rows: i64, // pg_class.reltuples
}

impl Table {
    /// attnum → columns indeksi (dropped kolonlar çıkarıldığı için gap olabilir).
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
    /// DEFAULT'lu arg (çağrıda atlanabilir). Signature help Phase 1'de gösterecek.
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
    pub comment: Option<String>,
}

impl Function {
    /// "get_user_orders(user_id int4) → setof orders" — öneri/peek etiketi.
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
    /// Katalogdan; explorer'da şema sahibini göstermek için (Phase 1).
    #[allow(dead_code)]
    pub owner: String,
    pub is_system: bool,
}

/// Immutable şema snapshot'ı + hızlı lookup indeksleri.
pub struct SchemaCache {
    pub fetched_at: DateTime<Utc>,
    pub server_version: String,
    pub search_path: Vec<String>,
    pub schemas: Vec<SchemaInfo>,

    pub tables: HashMap<TableId, Table>,
    pub functions: HashMap<FunctionId, Function>,

    // ---- Lookup indeksleri (fetch sonrası bir kez kurulur) ----
    pub table_by_qualified: HashMap<String, TableId>, // "schema.name" (lc) → id
    pub table_by_name: HashMap<String, SmallVec<[TableId; 2]>>, // "name" (lc) → ids
    pub function_by_name: HashMap<String, SmallVec<[FunctionId; 2]>>,
    pub fk_adjacency: HashMap<TableId, Vec<FkEdge>>, // iki yönlü (design 03 §1)
}

impl SchemaCache {
    /// Ham katalog verisinden cache'i kur: indeksleri ve FK grafiğini hesapla.
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

        // FK grafiği iki yönlü: bir tablodan hem giden hem gelen FK'lar görünür.
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

    /// Boş cache (bağlantı kurulmuş ama fetch bitmemiş durum).
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

    /// Bir tablonun tahmini satır sayısı (pg_class.reltuples). Destructive guard'ın
    /// "~2.1M satır etkilenecek" mesajı için (design 11 §H6). `name` yalın ("orders")
    /// ya da şema-nitelikli ("public.orders") olabilir; yalın adlar search_path
    /// önceliğiyle çözülür.
    pub fn table_estimated_rows(&self, name: &str) -> Option<i64> {
        let id = if let Some((schema, tbl)) = name.split_once('.') {
            self.table_by_qualified
                .get(&format!("{schema}.{tbl}").to_lowercase())
                .copied()
        } else {
            self.table_by_name.get(&name.to_lowercase()).and_then(|ids| {
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
        // reltuples = -1 → hiç analiz edilmemiş (bilinmiyor); tahmin gösterme.
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
        // Aynı ad iki şemada; search_path'te public var → public'inki seçilir.
        let c = cache(vec![
            tbl(1, "public", "orders", 5000),
            tbl(2, "archive", "orders", 9),
        ]);
        assert_eq!(c.table_estimated_rows("orders"), Some(5000));
    }

    #[test]
    fn estimated_rows_qualified_and_unknown() {
        let c = cache(vec![tbl(1, "archive", "orders", 42), tbl(2, "public", "t", -1)]);
        assert_eq!(c.table_estimated_rows("archive.orders"), Some(42));
        // -1 (analiz edilmemiş) → None; olmayan tablo → None.
        assert_eq!(c.table_estimated_rows("t"), None);
        assert_eq!(c.table_estimated_rows("nope"), None);
    }
}

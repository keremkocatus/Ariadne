//! The lightweight schema view sent to the frontend.
//!
//! The FK graph and function argument detail are NOT included here; completion is
//! computed in Rust. `to_snapshot` produces a deterministically ordered
//! `SchemaSnapshot` from the immutable cache.

use std::collections::HashMap;

use serde::Serialize;

use super::{FnKind, RelKind, SchemaCache};

impl SchemaCache {
    /// The lightweight view the tree + fuzzy search need.
    pub fn to_snapshot(&self) -> SchemaSnapshot {
        let mut by_schema: HashMap<&str, SnapSchema> = HashMap::new();
        for s in &self.schemas {
            by_schema.insert(
                s.name.as_str(),
                SnapSchema {
                    name: s.name.clone(),
                    is_system: s.is_system,
                    relations: Vec::new(),
                    functions: Vec::new(),
                },
            );
        }

        for t in self.tables.values() {
            if let Some(sch) = by_schema.get_mut(t.schema.as_str()) {
                sch.relations.push(SnapRel {
                    oid: t.id,
                    name: t.name.clone(),
                    kind: t.kind,
                    estimated_rows: t.estimated_rows,
                    comment: t.comment.clone(),
                    parent_oid: t.partition_of,
                    partition_bound: t.partition_bound.clone(),
                    columns: t
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(i, c)| SnapCol {
                            name: c.name.clone(),
                            type_name: c.type_name.clone(),
                            not_null: c.not_null,
                            is_pk: t.primary_key.contains(&i),
                        })
                        .collect(),
                });
            }
        }

        for f in self.functions.values() {
            if let Some(sch) = by_schema.get_mut(f.schema.as_str()) {
                sch.functions.push(SnapFn {
                    oid: f.id,
                    name: f.name.clone(),
                    signature: f.signature(),
                    kind: f.kind,
                    is_trigger: f.is_trigger,
                    extension: f.extension.clone(),
                    comment: f.comment.clone(),
                });
            }
        }

        // Deterministic order: by schema name, then by object name.
        let mut schemas: Vec<SnapSchema> = by_schema.into_values().collect();
        schemas.sort_by(|a, b| a.name.cmp(&b.name));
        for sch in &mut schemas {
            sch.relations.sort_by(|a, b| a.name.cmp(&b.name));
            sch.functions.sort_by(|a, b| a.name.cmp(&b.name));
        }

        SchemaSnapshot {
            fetched_at: self.fetched_at.to_rfc3339(),
            server_version: self.server_version.clone(),
            search_path: self.search_path.clone(),
            schemas,
        }
    }
}

// ---- SchemaSnapshot: the frontend contract ----

#[derive(Debug, Serialize)]
pub struct SchemaSnapshot {
    pub fetched_at: String, // RFC3339
    pub server_version: String,
    pub search_path: Vec<String>,
    pub schemas: Vec<SnapSchema>,
}

#[derive(Debug, Serialize)]
pub struct SnapSchema {
    pub name: String,
    pub is_system: bool,
    pub relations: Vec<SnapRel>,
    pub functions: Vec<SnapFn>,
}

#[derive(Debug, Serialize)]
pub struct SnapRel {
    pub oid: u32,
    pub name: String,
    pub kind: RelKind,
    pub estimated_rows: i64,
    pub comment: Option<String>,
    /// For a partition: its parent's oid, so the tree can nest it under the parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_oid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partition_bound: Option<String>,
    pub columns: Vec<SnapCol>,
}

#[derive(Debug, Serialize)]
pub struct SnapCol {
    pub name: String,
    pub type_name: String,
    pub not_null: bool,
    pub is_pk: bool,
}

#[derive(Debug, Serialize)]
pub struct SnapFn {
    pub oid: u32,
    pub name: String,
    pub signature: String,
    pub kind: FnKind,
    pub is_trigger: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    pub comment: Option<String>,
}

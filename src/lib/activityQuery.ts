import { useTabsStore } from "@/stores/tabsStore";

/// Read-only "who's running what" query over pg_stat_activity. Excludes this app's own
/// backend and non-client backends (autovacuum, walwriter, …). Run in a normal query
/// tab so the result lands in the grid; kill a backend by running
/// pg_cancel_backend(pid) / pg_terminate_backend(pid) yourself.
export const SERVER_ACTIVITY_SQL = `SELECT
    pid,
    usename,
    datname,
    state,
    now() - query_start AS duration,
    wait_event_type,
    wait_event,
    client_addr,
    application_name,
    query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND pid <> pg_backend_pid()
ORDER BY query_start;`;

/// Opens a new tab bound to the given connection, drops in the activity query, and runs
/// it. Shared by the toolbar button and the command palette.
export function openServerActivity(connectionId: string | null): void {
  const tabs = useTabsStore.getState();
  const id = tabs.addTab(SERVER_ACTIVITY_SQL, connectionId);
  tabs.renameTab(id, "Server activity");
  void tabs.run(id);
}

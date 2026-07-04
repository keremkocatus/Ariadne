// The left panel: switches between Explorer / Roles / Activity via narrow tabs. The
// tab state is in uiStore (so the palette can switch it programmatically).
import { Table2, Users, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { Explorer } from "@/components/explorer/Explorer";
import { RolesPanel } from "@/components/roles/RolesPanel";
import { ActivityPanel } from "@/components/activity/ActivityPanel";
import { useUiStore } from "@/stores/uiStore";
import type { SnapFn } from "@/lib/api";

interface Props {
  connectionId: string | null;
  profileId: string | null;
  onOpenRelation: (schema: string, name: string) => void;
  onOpenFunction: (fn: SnapFn) => void;
}

export function Sidebar({ connectionId, profileId, onOpenRelation, onOpenFunction }: Props) {
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-border">
        <TabButton active={tab === "explorer"} onClick={() => setTab("explorer")} icon={<Table2 size={12} />}>
          Explorer
        </TabButton>
        <TabButton active={tab === "roles"} onClick={() => setTab("roles")} icon={<Users size={12} />}>
          Roles
        </TabButton>
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")} icon={<Activity size={12} />}>
          Activity
        </TabButton>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "explorer" ? (
          <Explorer
            connectionId={connectionId}
            profileId={profileId}
            onOpenRelation={onOpenRelation}
            onOpenFunction={onOpenFunction}
          />
        ) : tab === "roles" ? (
          <RolesPanel connectionId={connectionId} />
        ) : (
          <ActivityPanel connectionId={connectionId} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[11px]",
        active ? "border-b-2 border-fg text-fg" : "border-b-2 border-transparent text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

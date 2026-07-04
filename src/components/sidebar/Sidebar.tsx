// Sol panel: Explorer + Roles arasında dar sekmelerle geçiş (design 15 §P1-U4).
// M4'ün History paneli de aynı düzene oturacak.
import { useState } from "react";
import { Table2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Explorer } from "@/components/explorer/Explorer";
import { RolesPanel } from "@/components/roles/RolesPanel";
import type { SnapFn } from "@/lib/api";

type SidebarTab = "explorer" | "roles";

interface Props {
  connectionId: string | null;
  profileId: string | null;
  onOpenRelation: (schema: string, name: string) => void;
  onOpenFunction: (fn: SnapFn) => void;
}

export function Sidebar({ connectionId, profileId, onOpenRelation, onOpenFunction }: Props) {
  const [tab, setTab] = useState<SidebarTab>("explorer");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-border">
        <TabButton active={tab === "explorer"} onClick={() => setTab("explorer")} icon={<Table2 size={12} />}>
          Explorer
        </TabButton>
        <TabButton active={tab === "roles"} onClick={() => setTab("roles")} icon={<Users size={12} />}>
          Roles
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
        ) : (
          <RolesPanel connectionId={connectionId} />
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

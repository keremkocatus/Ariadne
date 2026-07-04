// Açılışta "dünkü çalışma alanını geri getir" daveti (design 17 §P1-V3 Ö2).
// Restore edilmiş tab'lar ölü connectionId taşır; bunları lastSession eşlemesiyle
// (profil, DB) çiftlerine çözer, hâlâ var olan profillere filtreler ve her çift
// için kalıcı bir "Reconnect" toast'ı gösterir. OTOMATİK bağlanma YOK (VPN'siz
// açılışta hata seli olmasın — design/16 kararı); tek tıklık davet.
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { isAriadneError } from "@/lib/api";

// Aynı açılışta ikinci kez davet üretmeyi engeller (StrictMode / tekrar çağrı).
let offered = false;

interface Invite {
  profileId: string;
  database: string;
  oldIds: Set<string>;
}

/// Restore edilmiş, ölü bağlantılı tab'lardan distinct (profil, DB) davetleri çıkarır.
function collectInvites(): Invite[] {
  const conn = useConnectionStore.getState();
  const tabs = useTabsStore.getState().tabs;
  const byPair = new Map<string, Invite>();
  for (const t of tabs) {
    const cid = t.connectionId;
    if (!cid) continue;
    if (conn.connections[cid]) continue; // zaten canlı (açılışta olmaz ama garanti)
    const rec = conn.lastSession[cid];
    if (!rec) continue;
    if (!conn.profiles.some((p) => p.id === rec.profileId)) continue; // profil silinmiş
    const key = `${rec.profileId}::${rec.database}`;
    const inv = byPair.get(key) ?? { profileId: rec.profileId, database: rec.database, oldIds: new Set() };
    inv.oldIds.add(cid);
    byPair.set(key, inv);
  }
  return [...byPair.values()];
}

/// Reconnect eylemi: bağlan (ya da varsa mevcut bağlantıyı bul), snapshot yükle,
/// eski id'li tab'ları yeni bağlantıya taşı, tüketilen oturum kayıtlarını unut.
async function reconnectAndRemap(inv: Invite): Promise<void> {
  const conn = useConnectionStore.getState();
  try {
    let newId = conn.findConnection(inv.profileId, inv.database);
    if (!newId) {
      newId = await conn.connect(inv.profileId, inv.database);
      await useSchemaStore.getState().loadSnapshot(newId);
    }
    useTabsStore.getState().remapConnection([...inv.oldIds], newId);
    useConnectionStore.getState().setActive(newId);
    useConnectionStore.getState().forgetSession([...inv.oldIds]);
  } catch (e) {
    toast.error("Could not reconnect", {
      description: isAriadneError(e) ? e.message : String(e),
    });
  }
}

/// App mount'unda (profiller yüklendikten sonra) bir kez çağrılır. En fazla 3
/// davet (gürültü sınırı). Eşleşen tab yoksa sessiz kalır.
export function offerReconnect(): void {
  if (offered) return;
  offered = true;
  const invites = collectInvites().slice(0, 3);
  for (const inv of invites) {
    const conn = useConnectionStore.getState();
    const name = conn.profiles.find((p) => p.id === inv.profileId)?.name ?? inv.database;
    toast(`Reconnect to ${name}?`, {
      duration: Infinity,
      action: {
        label: "Reconnect",
        onClick: () => void reconnectAndRemap(inv),
      },
    });
  }
}

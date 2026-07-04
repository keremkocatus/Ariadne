// Açılışta "dünkü çalışma alanını geri getir" daveti (design 17 §P1-V3 Ö2).
// Restore edilmiş tab'lar ölü connectionId taşır; bunları lastSession eşlemesiyle
// (profil, DB) çiftlerine çözer, hâlâ var olan profillere filtreler ve her çift
// için kalıcı bir "Reconnect" toast'ı gösterir. OTOMATİK bağlanma YOK (VPN'siz
// açılışta hata seli olmasın — design/16 kararı); tek tıklık davet.
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { isAriadneError, type ConnectionProfile } from "@/lib/api";

// Aynı açılışta ikinci kez davet üretmeyi engeller (StrictMode / tekrar çağrı).
let offered = false;

// Davet toast'ı bu kadar durur (design 18 §P1-W1 N2 — eskiden Infinity, takılıyordu).
const RECONNECT_TOAST_MS = 30_000;

/// Bir (profil, DB) davet toast'ının stabil id'si — üst üste yığılmasın + başka
/// yoldan bağlanınca söndürülebilsin (design 18 §P1-W1).
export function reconnectToastId(profileId: string, database: string): string {
  return `reconnect:${profileId}:${database}`;
}

/// O (profil, DB) için bekleyen reconnect davetini söndürür — kullanıcı menüden
/// bağlandığında connectProfile bunu çağırır (design 18 §P1-W1 N2).
export function dismissReconnectToast(profileId: string, database: string): void {
  toast.dismiss(reconnectToastId(profileId, database));
}

interface Invite {
  profile: ConnectionProfile;
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
    const profile = conn.profiles.find((p) => p.id === rec.profileId);
    if (!profile) continue; // profil silinmiş
    const key = `${rec.profileId}::${rec.database}`;
    const inv = byPair.get(key) ?? { profile, database: rec.database, oldIds: new Set() };
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
    let newId = conn.findConnection(inv.profile.id, inv.database);
    if (!newId) {
      newId = await conn.connect(inv.profile.id, inv.database);
      await useSchemaStore.getState().loadSnapshot(newId);
    }
    useTabsStore.getState().remapConnection([...inv.oldIds], newId);
    useConnectionStore.getState().setActive(newId);
    useConnectionStore.getState().forgetSession([...inv.oldIds]);
    dismissReconnectToast(inv.profile.id, inv.database);
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
    const p = inv.profile;
    // Etiket: profil adı + sunucu/DB (design 18 §P1-W1 N1) — aynı DB adının iki
    // sunucudaki hali host ile ayrışsın.
    toast(`Reconnect to ${p.name}?`, {
      id: reconnectToastId(p.id, inv.database),
      description: `${p.user}@${p.host}:${p.port} · ${inv.database}`,
      duration: RECONNECT_TOAST_MS,
      closeButton: true,
      action: {
        label: "Reconnect",
        onClick: () => void reconnectAndRemap(inv),
      },
    });
  }
}

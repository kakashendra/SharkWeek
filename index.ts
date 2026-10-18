import { createClient } from "npm:@supabase/supabase-js@2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BOT = Deno.env.get("BOT_TOKEN")!, CRON = Deno.env.get("CRON_SECRET")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const DAY = 864e5, TZ = 5 * 3600e3; // часовой пояс Екатеринбурга
const ms = (s: string) => Date.parse(s + "T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

const ADV: Record<string, [string, string]> = {
  menstrual: ["🩸 Менструация", "Начались месячные. Будь мягче и внимательнее: тепло, чай, спокойный вечер, не спорь по мелочам."],
  follicular: ["🌱 Фолликулярная фаза", "Энергия и настроение растут. Хорошее время для свиданий и совместных планов."],
  ovulation: ["✨ Овуляция", "Пик энергии и общительности. Если беременность не планируется, не забудь про защиту."],
  luteal: ["🌙 Лютеиновая фаза", "Возможны усталость, раздражительность и тяга к сладкому (ПМС). Больше поддержки и терпения, меньше критики."],
};

async function verify(initData: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash")!; p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const enc = new TextEncoder();
  const hm = async (key: Uint8Array, msg: string | Uint8Array) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof msg === "string" ? enc.encode(msg) : msg));
  };
  const secret = await hm(enc.encode("WebAppData"), BOT);
  const sig = [...await hm(secret, str)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) throw new Error("bad signature");
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) throw new Error("session expired");
  return JSON.parse(p.get("user")!);
}

async function calc(owner: number) {
  const { data: u } = await db.from("users").select().eq("id", owner).single();
  const { data: ev } = await db.from("events").select("kind,date").eq("owner", owner).order("date");
  const s = ev!.filter((e) => e.kind == "period").map((e) => e.date);
  let phase = null;
  if (s.length) {
    let cyc = u.cycle_len;
    if (s.length > 1) {
      const r = s.slice(-7).map((x, i, a) => (i ? (ms(x) - ms(a[i - 1])) / DAY : 0)).slice(1);
      cyc = Math.min(45, Math.max(20, Math.round(r.reduce((a, b) => a + b) / r.length)));
    }
    const today = ms(iso(Date.now() + TZ)), last = ms(s[s.length - 1]);
    const n = Math.max(0, Math.floor((today - last) / DAY));
    const day = (n % cyc) + 1, ov = cyc - 14;
    const key = day <= u.period_len ? "menstrual" : day < ov - 1 ? "follicular" : day <= ov + 1 ? "ovulation" : "luteal";
    phase = { key, day, cyc, next: iso(last + (Math.floor(n / cyc) + 1) * cyc * DAY), title: ADV[key][0], advice: ADV[key][1] };
  }
  return { u, ev: ev!, phase };
}

Deno.serve(async (req) => {
  if (req.method == "OPTIONS") return out({});
  try {
    const b = await req.json();
    if (b.action == "notify") {
      if (req.headers.get("x-cron") != CRON) return out({ error: "no" }, 403);
      const { data: links } = await db.from("links").select("owner,partner");
      for (const id of new Set(links!.map((l) => l.owner))) {
        const { u, phase } = await calc(id);
        if (!phase || u.last_phase == phase.key) continue;
        for (const l of links!.filter((l) => l.owner == id)) {
          await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: l.partner, text: `${u.name}: ${phase.title} (день ${phase.day})\n\n${phase.advice}` }),
          });
        }
        await db.from("users").update({ last_phase: phase.key }).eq("id", id);
      }
      return out({ ok: 1 });
    }

    const tu = await verify(b.initData), me = tu.id;
    await db.from("users").upsert({ id: me, name: tu.first_name }, { onConflict: "id" });

    if (b.action == "add" || b.action == "del") {
      if (!["period", "sex"].includes(b.kind) || !/^\d{4}-\d\d-\d\d$/.test(b.date)) return out({ error: "bad data" }, 400);
      if (b.action == "add") await db.from("events").upsert({ owner: me, kind: b.kind, date: b.date }, { onConflict: "owner,kind,date" });
      else await db.from("events").delete().match({ owner: me, kind: b.kind, date: b.date });
      return out({ ok: 1 });
    }
    if (b.action == "invite") {
      const code = crypto.randomUUID().slice(0, 8);
      await db.from("invites").insert({ code, owner: me });
      return out({ code });
    }
    if (b.action == "accept") {
      const { data: i } = await db.from("invites").select().eq("code", b.code).maybeSingle();
      if (!i || i.owner == me) return out({ error: "invalid invite" }, 400);
      await db.from("links").upsert({ owner: i.owner, partner: me });
      await db.from("invites").delete().eq("code", b.code);
      return out({ ok: 1 });
    }
    if (b.action == "unlink") {
      const x = Number(b.id);
      await db.from("links").delete().or(`and(owner.eq.${me},partner.eq.${x}),and(owner.eq.${x},partner.eq.${me})`);
      return out({ ok: 1 });
    }

    const owner = b.owner || me;
    if (owner != me) {
      const { data: l } = await db.from("links").select().match({ owner, partner: me }).maybeSingle();
      if (!l) return out({ error: "forbidden" }, 403);
    }
    const { data: viewable } = await db.from("links").select("owner").eq("partner", me);
    const ids = [me, ...viewable!.map((x) => x.owner)];
    const { data: people } = await db.from("users").select("id,name").in("id", ids);
    const { u, ev, phase } = await calc(owner);
    return out({ me, owner, name: u.name, people, ev, phase });
  } catch (e) {
    return out({ error: String((e as Error).message || e) }, 400);
  }
});

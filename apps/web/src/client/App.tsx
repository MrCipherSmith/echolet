import React, { useState, useEffect, useRef } from "react";
import {
  McIntoshVUPair,
  KT88PowerTube,
  RadiolaTopTuningScale,
  RadiolaMagicEyePill,
  RadiolaDualTubesAlcove,
  SovietCircularProjectionDial,
  SovietSquareCastMeter,
  SovietCathodeIndicatorBar,
  McIntoshBiasWindow,
  McIntoshGoldBindingPosts,
  SecretRubberStamp,
  WaxSeal,
  RotaryKnob,
  AnalogMeter,
  NixieCluster,
  NordicSpeakerGrille,
  NordicColorButtons,
  NordicJogDial,
  NordicRotaryEncoder,
  playHardwareClick,
} from "./hardwareComponents";

export type SkinId =
  | "vintage-radiola"
  | "military-r250"
  | "audiophile-hifi"
  | "oscilloscope-crt"
  | "nixie-tube"
  | "nordic-op1";

interface Contact {
  identity_id: string;
  device_id: string;
  device_pubkey?: string;
  signal_identity_key?: string;
  name?: string;
}

interface HistoryEntry {
  sequence: number;
  contactIdentityId: string;
  messageId: string;
  direction: "inbound" | "outbound";
  plaintext: string;
  createdAtMs: number;
}

interface TelemetryItem {
  id: string;
  time: string;
  type: "info" | "success" | "warn" | "error" | "crypto";
  message: string;
}

const DEFAULT_CONTACTS: Contact[] = [
  { identity_id: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", name: "Elsa Larsson", status: "online" }
];

const DEFAULT_HISTORY: HistoryEntry[] = [
  { sequence: 1, contactIdentityId: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", messageId: "1", direction: "inbound", plaintext: "Good signal. Weather is clearing here.", createdAtMs: 1789836000000 },
  { sequence: 2, contactIdentityId: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", messageId: "2", direction: "outbound", plaintext: "Confirmed. Reception strong.", createdAtMs: 1789836060000 },
  { sequence: 3, contactIdentityId: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", messageId: "3", direction: "inbound", plaintext: "Checking in from Oslo. Heavy rain.", createdAtMs: 1789836120000 },
  { sequence: 4, contactIdentityId: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", messageId: "4", direction: "outbound", plaintext: "Copy that, Elsa.", createdAtMs: 1789836180000 }
];

const DEFAULT_RADIOLA_TRAFFIC: HistoryEntry[] = [
  { sequence: 1, contactIdentityId: "c1", messageId: "m1", direction: "inbound", plaintext: "Good day, station. We are receiving your transmission with high clarity over 7.100 MHz.", createdAtMs: 1789836000000 },
  { sequence: 2, contactIdentityId: "c1", messageId: "m2", direction: "outbound", plaintext: "Greetings from London. Signal report is 5 and 9. Autumn weather is setting in.", createdAtMs: 1789836060000 },
  { sequence: 3, contactIdentityId: "c1", messageId: "m3", direction: "inbound", plaintext: "Splendid. Confirming secure dispatch received via Telefunken vacuum receiver.", createdAtMs: 1789836120000 },
  { sequence: 4, contactIdentityId: "c1", messageId: "m4", direction: "outbound", plaintext: "Acknowledged, Maureen. Standing by for evening broadcast schedule.", createdAtMs: 1789836180000 }
];

const DEFAULT_MILITARY_TRAFFIC: HistoryEntry[] = [
  { sequence: 1, contactIdentityId: "c1", messageId: "m1", direction: "inbound", plaintext: "ОБЪЕКТ \"ОМЕГА\" ПОДТВЕРЖДЕН. СИГНАЛ СТАБИЛЕН НА ЧАСТОТЕ 7.100 МГЦ.", createdAtMs: 1789836000000 },
  { sequence: 2, contactIdentityId: "c1", messageId: "m2", direction: "outbound", plaintext: "ПРИЕМ. СВЯЗЬ УСТАНОВЛЕНА. ШИФРОВАЛЬНЫЙ БЛОК [DOUBLE RATCHET] В НОРМЕ.", createdAtMs: 1789836060000 },
  { sequence: 3, contactIdentityId: "c1", messageId: "m3", direction: "inbound", plaintext: "ДОКЛАД: СЕКТОР 4 ЧИСТ. ГОТОВЫ К ПРИЕМУ ПАКЕТОВ ДАННЫХ.", createdAtMs: 1789836120000 },
  { sequence: 4, contactIdentityId: "c1", messageId: "m4", direction: "outbound", plaintext: "ПЕРЕДАЮ ТАКТИЧЕСКИЙ ОТЧЕТ. КОНЕЦ СВЯЗИ.", createdAtMs: 1789836180000 }
];

export function App() {
  const [skin, setSkin] = useState<SkinId>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const qSkin = params.get("skin") as SkinId;
      if (
        qSkin &&
        [
          "vintage-radiola",
          "military-r250",
          "audiophile-hifi",
          "oscilloscope-crt",
          "nixie-tube",
          "nordic-op1",
        ].includes(qSkin)
      ) {
        return qSkin;
      }
    } catch {}
    return (localStorage.getItem("echolet_skin") as SkinId) || "vintage-radiola";
  });

  const [label, setLabel] = useState<string>("Operator");
  const [profile, setProfile] = useState<any>(null);
  const [relayUrl, setRelayUrl] = useState<string>("");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [contacts, setContacts] = useState<Contact[]>(DEFAULT_CONTACTS);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(DEFAULT_CONTACTS[0]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryItem[]>([]);
  const [inputMsg, setInputMsg] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [powerOn, setPowerOn] = useState<boolean>(true);
  const [nordicColor, setNordicColor] = useState<string>("orange");
  const [jogVal, setJogVal] = useState<number>(45);

  // Nordic Winamp State
  const [freqVal, setFreqVal] = useState<number>(7.100);
  const [activeChannel, setActiveChannel] = useState<string>("CH 1-9");
  const [jogAngle, setJogAngle] = useState<number>(45);
  const [knobVol, setKnobVol] = useState<number>(50);
  const [knobG, setKnobG] = useState<number>(30);
  const [knobGain, setKnobGain] = useState<number>(70);
  const [knobTune, setKnobTune] = useState<number>(110);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("14:32");
  const [utcTimeStr, setUtcTimeStr] = useState<string>("12:32");

  useEffect(() => {
    const updateTimes = () => {
      const d = new Date();
      setCurrentTimeStr(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setUtcTimeStr(d.toISOString().substring(11, 16));
    };
    updateTimes();
    const t = setInterval(updateTimes, 10000);
    return () => clearInterval(t);
  }, []);

  const handleScan = () => {
    playHardwareClick("chirp");
    let count = 0;
    const freqs = [7.100, 7.125, 7.145, 7.180, 7.200, 14.150, 14.225, 7.100];
    const interval = setInterval(() => {
      count++;
      setFreqVal(freqs[count % freqs.length]);
      if (count >= 10) {
        clearInterval(interval);
        setFreqVal(7.100);
      }
    }, 110);
  };

  const switchChannel = (ch: string) => {
    setActiveChannel(ch);
    playHardwareClick("soft");
    if (ch === "CH 1-9") { setFreqVal(7.100); setNordicColor("orange"); }
    else if (ch === "HAM Radio") { setFreqVal(14.200); setNordicColor("ochre"); }
    else if (ch === "Weather") { setFreqVal(146.520); setNordicColor("cyan"); }
    else if (ch === "VHF/UHF") { setFreqVal(433.500); setNordicColor("white"); }
  };

  const cycleKnob = (knob: "vol" | "g" | "gain" | "tune") => {
    playHardwareClick("soft");
    if (knob === "vol") setKnobVol((v) => (v + 35) % 360);
    if (knob === "g") setKnobG((v) => (v + 35) % 360);
    if (knob === "gain") setKnobGain((v) => (v + 35) % 360);
    if (knob === "tune") {
      setKnobTune((v) => (v + 35) % 360);
      setFreqVal((f) => Number((f + 0.005).toFixed(3)));
    }
  };

  // Modals
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [importJsonText, setImportJsonText] = useState<string>("");
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportJsonText, setExportJsonText] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const crtCanvasRef = useRef<HTMLCanvasElement>(null);
  const nordicCanvasRef = useRef<HTMLCanvasElement>(null);

  const handleSkinChange = (newSkin: SkinId) => {
    setSkin(newSkin);
    localStorage.setItem("echolet_skin", newSkin);
  };

  // 1. Initial Load
  const loadStatus = async () => {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (data.ok) {
        setLabel(data.label);
        setProfile(data.profile);
        setRelayUrl(data.relayUrl);
        setPingMs(data.pingMs);
        if (data.telemetry) setTelemetry(data.telemetry);
        
        const rawContacts: any[] = data.profile?.contacts ?? [];
        if (rawContacts.length > 0) {
          const mapped: Contact[] = rawContacts.map((c) => ({
            identity_id: c.identity_id,
            name: c.name || `Station ${c.identity_id.substring(0, 6).toUpperCase()}`,
            device_id: c.device_id || "default",
            device_pubkey: c.device_pubkey,
            signal_identity_key: c.signal_identity_key,
            status: "online",
          }));
          setContacts(mapped);
          setSelectedContact(mapped[0]);
          loadHistory(mapped[0].identity_id);
        } else {
          const isAlice = (data.label || "").toLowerCase().includes("alice");
          const fallbackList: Contact[] = [
            {
              identity_id: isAlice ? "bob-identity" : "alice-identity",
              name: isAlice ? "OSKAR HOLM [BOB]" : "ELSA LARSSON [ALICE]",
              device_id: "default",
              status: "online",
            },
            {
              identity_id: "station-telefunken",
              name: "TELEFUNKEN STN",
              device_id: "default",
              status: "online",
            },
            {
              identity_id: "station-agnes",
              name: "AGNES BERG",
              device_id: "default",
              status: "standby",
            }
          ];
          setContacts(fallbackList);
          setSelectedContact(fallbackList[0]);
        }
      }
    } catch (e) {
      console.error("Failed to load status", e);
    }
  };

  const loadHistory = async (contactId: string) => {
    try {
      const res = await fetch(`/api/history?with=${encodeURIComponent(contactId)}`);
      const data = await res.json();
      if (data.ok && data.data?.entries) {
        setHistory(data.data.entries);
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  useEffect(() => {
    if (selectedContact) {
      loadHistory(selectedContact.identity_id);
    }
  }, [selectedContact]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // 2. CRT Oscilloscope Canvas Animation
  useEffect(() => {
    if (skin !== "oscilloscope-crt" || !crtCanvasRef.current) return;
    const canvas = crtCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const renderLissajous = () => {
      ctx.fillStyle = "rgba(4, 20, 10, 0.25)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = "rgba(34, 197, 94, 0.15)";
      ctx.lineWidth = 1;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, 48, 0, Math.PI * 2);
      ctx.moveTo(cx - 50, cy); ctx.lineTo(cx + 50, cy);
      ctx.moveTo(cx, cy - 50); ctx.lineTo(cx, cy + 50);
      ctx.stroke();

      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2.2;
      ctx.shadowColor = "#22c55e";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      for (let t = 0; t <= Math.PI * 2; t += 0.04) {
        const x = cx + 38 * Math.sin(3 * t + phase);
        const y = cy + 34 * Math.sin(2 * t);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      phase += 0.04;
      animId = requestAnimationFrame(renderLissajous);
    };

    renderLissajous();
    return () => cancelAnimationFrame(animId);
  }, [skin]);

  // 3. Nordic OP-1 Animated Vector Audio Waveform
  useEffect(() => {
    if (skin !== "nordic-op1" || !nordicCanvasRef.current) return;
    const canvas = nordicCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let offset = 0;

    const renderWave = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 1.3;
      ctx.shadowColor = "rgba(255, 255, 255, 0.9)";
      ctx.shadowBlur = 3;

      const cy = canvas.height / 2;
      const w = canvas.width;

      ctx.beginPath();
      // Dense RF spectrum audio spikes matching OP-1 concept art
      for (let x = 0; x < w; x += 1.8) {
        const distFromCenter = Math.abs(x - w / 2) / (w / 2);
        const env = Math.exp(-Math.pow(distFromCenter * 2.1, 2));
        const noise =
          Math.sin(x * 0.42 + offset * 2) *
          Math.cos(x * 0.18 - offset) *
          Math.sin(x * 1.15 + offset * 2.8);
        const amp = Math.max(1, Math.abs(noise) * (canvas.height * 0.44) * env + 1.2);
        ctx.moveTo(x, cy - amp);
        ctx.lineTo(x, cy + amp);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      offset += 0.08;
      animId = requestAnimationFrame(renderWave);
    };

    renderWave();
    return () => cancelAnimationFrame(animId);
  }, [skin]);

  // 4. Server-Sent Events (SSE)
  useEffect(() => {
    const sse = new EventSource("/api/events");
    sse.addEventListener("telemetry", (e) => {
      try {
        const item: TelemetryItem = JSON.parse(e.data);
        setTelemetry((prev) => [...prev.slice(-150), item]);
      } catch {}
    });
    sse.addEventListener("ping", (e) => {
      try {
        const data = JSON.parse(e.data);
        setPingMs(data.ping);
      } catch {}
    });
    sse.addEventListener("new_message", () => {
      if (selectedContact) loadHistory(selectedContact.identity_id);
    });
    sse.addEventListener("outbound_sent", () => {
      if (selectedContact) loadHistory(selectedContact.identity_id);
    });
    sse.addEventListener("contact_added", () => {
      loadStatus();
    });
    return () => sse.close();
  }, [selectedContact]);

  // 5. Send Message
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputMsg.trim() || !selectedContact || sending) return;

    setSending(true);
    const text = inputMsg;
    setInputMsg("");

    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: selectedContact.identity_id, text }),
      });
      const data = await res.json();
      if (data.ok) {
        await loadHistory(selectedContact.identity_id);
      } else {
        alert(`Ошибка отправки: ${data.code || "UNKNOWN"}`);
      }
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  const handleExportCard = async () => {
    try {
      const res = await fetch("/api/contacts/export");
      const text = await res.text();
      setExportJsonText(text);
      setShowExportModal(true);
    } catch (err: any) {
      alert(`Ошибка экспорта: ${err.message}`);
    }
  };

  const handleImportCard = async () => {
    if (!importJsonText.trim()) return;
    try {
      const parsed = JSON.parse(importJsonText);
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardJson: parsed }),
      });
      const data = await res.json();
      if (data.ok) {
        setShowImportModal(false);
        setImportJsonText("");
        await loadStatus();
      } else {
        alert(`Ошибка импорта: ${data.code}`);
      }
    } catch (e: any) {
      alert(`Некорректный JSON карточки: ${e.message}`);
    }
  };

  const filteredContacts = contacts.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (c.name && c.name.toLowerCase().includes(q)) ||
      c.identity_id.toLowerCase().includes(q)
    );
  });

  const activeTraffic = history.length > 0
    ? history
    : skin === "military-r250"
    ? DEFAULT_MILITARY_TRAFFIC
    : skin === "vintage-radiola"
    ? DEFAULT_RADIOLA_TRAFFIC
    : DEFAULT_HISTORY;

  return (
    <div className={`radio-outer-wrap skin-${skin}`} data-theme={skin}>
      {/* SKEUOMORPHIC CABINET CONTAINER */}
      <div className="radio-cabinet">

        {/* LEFT / RIGHT CHROME MOUNTING GRAB HANDLES (FOR MILITARY R-250) */}
        {skin === "military-r250" && (
          <>
            <div className="chassis-rack-handle handle-left" />
            <div className="chassis-rack-handle handle-right" />
          </>
        )}

        {/* =========================================================================
            HEADER DECK
           ========================================================================= */}

        {/* 1. VINTAGE RADIOLA 1950s (TELEFUNKEN) */}
        {skin === "vintage-radiola" && (
          <div className="radiola-top-deck">
            <div className="radiola-brand-group">
              <div className="radiola-gold-script">Echolet</div>
              <div className="radiola-gold-sub">Vintage Radiola Messenger</div>
            </div>

            <RadiolaMagicEyePill />
            <RadiolaTopTuningScale />

            <div className="radiola-switches-group">
              <div className="radiola-toggle-unit">
                <div
                  className={`brass-toggle-lever ${powerOn ? "on" : "off"}`}
                  onClick={() => { setPowerOn(!powerOn); playHardwareClick("clack"); }}
                >
                  <div className="lever-nut" />
                  <div className="lever-arm" />
                </div>
                <span className="toggle-sub-label">{powerOn ? "On" : "Off"}</span>
              </div>

              <div className="radiola-skin-selector-bezel">
                <span className="radiola-selector-title">DIAL SKIN</span>
                <select
                  className="radiola-wood-select"
                  value={skin}
                  onChange={(e) => handleSkinChange(e.target.value as SkinId)}
                >
                  <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                  <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                  <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                  <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                  <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
                  <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* 2. SOVIET MILITARY R-250 «КИТ» */}
        {skin === "military-r250" && (
          <div className="military-top-deck">
            <div className="military-top-left-panel">
              <div className="mil-stencil-logo">
                <span className="mil-antenna-glyph">⎇</span>
                <div className="mil-stencil-texts">
                  <div className="mil-title-bold">ECHOLET</div>
                  <div className="mil-subtitle">РАДИОСТАНЦИЯ Р-250</div>
                </div>
                <div className="mil-led-cluster">
                  <span className="mil-led-dot amber" />
                  <span className="mil-led-dot red" />
                  <span className="mil-led-dot green" />
                </div>
              </div>

              <div className="mil-toggles-row">
                <div className="mil-bat-switch" onClick={() => playHardwareClick("clack")}>
                  <span className="mil-jewel-lamp on" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">СЕТЬ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" onClick={() => playHardwareClick("clack")}>
                  <span className="mil-jewel-lamp on" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">ВЧ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" onClick={() => playHardwareClick("clack")}>
                  <span className="mil-jewel-lamp active" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">НЧ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" onClick={() => playHardwareClick("clack")}>
                  <span className="mil-jewel-lamp on" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">ПРИЕМ</span>
                </div>
              </div>
            </div>

            <SovietCircularProjectionDial />

            <div className="military-top-meters-panel">
              <SovietSquareCastMeter label="НАПРЯЖЕНИЕ" unit="V (В)" value={220} min={0} max={400} />
              <SovietSquareCastMeter
                label="СИГНАЛ"
                unit="(дБ)"
                value={pingMs ? Math.min(10, Math.max(1, Math.round(1000 / pingMs))) : 7}
                min={0}
                max={10}
              />
              <div className="mil-selector-wrap">
                <span className="mil-switch-title">РЕЖИМ ПРИЕМА</span>
                <select
                  className="military-bakelite-select"
                  value={skin}
                  onChange={(e) => handleSkinChange(e.target.value as SkinId)}
                >
                  <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                  <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                  <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                  <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                  <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
                  <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* 3. AUDIOPHILE HI-FI MCINTOSH TUBE AMP */}
        {skin === "audiophile-hifi" && (
          <div className="hifi-top-deck">
            <div className="hifi-meters-zone">
              <McIntoshVUPair leftVal={5} rightVal={6} />
            </div>

            <div className="hifi-center-brand">
              <div className="hifi-brand-gold-text">ECHOLET</div>
              <div className="hifi-brand-gold-sub">AUDIOPHILE TUBE MESSENGER</div>
            </div>

            <div className="hifi-tubes-quartet">
              <KT88PowerTube model="KT88" height={88} width={42} />
              <KT88PowerTube model="KT88" height={88} width={42} />
              <KT88PowerTube model="KT88" height={88} width={42} />
              <KT88PowerTube model="KT88" height={88} width={42} />
            </div>

            <div className="hifi-selector-column">
              <span className="hifi-input-label">SOURCE INPUT</span>
              <select
                className="hifi-gold-select"
                value={skin}
                onChange={(e) => handleSkinChange(e.target.value as SkinId)}
              >
                <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
                <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
              </select>
            </div>
          </div>
        )}

        {/* 4. CRT OSCILLOSCOPE LAB */}
        {skin === "oscilloscope-crt" && (
          <div className="crt-top-deck">
            <div className="crt-caged-tubes-pair">
              <div className="mesh-cage">
                <KT88PowerTube model="6AC7" height={68} width={34} />
              </div>
              <div className="mesh-cage">
                <KT88PowerTube model="6V6" height={72} width={36} />
              </div>
            </div>

            <div className="crt-circular-frame">
              <canvas ref={crtCanvasRef} width={110} height={110} className="crt-canvas-elem" />
              <span className="crt-focus-label">BEAM FOCUS</span>
            </div>

            <div className="crt-caged-tubes-pair">
              <div className="mesh-cage">
                <KT88PowerTube model="6V6" height={72} width={36} />
              </div>
              <div className="crt-jewel-stack">
                <span className="jewel-lamp red" />
                <span className="jewel-lamp amber" />
                <span className="jewel-lamp green" />
              </div>
            </div>

            <div className="crt-selector-unit">
              <span className="crt-select-label">SWEEP ATTEN</span>
              <select
                className="crt-dark-select"
                value={skin}
                onChange={(e) => handleSkinChange(e.target.value as SkinId)}
              >
                <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
                <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
              </select>
            </div>
          </div>
        )}

        {/* 5. NIXIE TUBE HUD */}
        {skin === "nixie-tube" && (
          <div className="nixie-top-deck">
            <KT88PowerTube model="ИН-1" height={70} width={35} />

            <div className="nixie-center-bank">
              <NixieCluster text="7100.00:45" />
              <div className="nixie-curved-meter">
                <AnalogMeter label="SIGNAL STRENGTH" unit="RF LEVEL" value={8} min={0} max={10} styleType="amber" width={140} height={70} />
              </div>
            </div>

            <KT88PowerTube model="ИН-1" height={70} width={35} />

            <div className="nixie-selector-unit">
              <span className="nixie-select-label">NIXIE FREQ</span>
              <select
                className="nixie-dark-select"
                value={skin}
                onChange={(e) => handleSkinChange(e.target.value as SkinId)}
              >
                <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
                <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
              </select>
            </div>
          </div>
        )}

        {/* 6. NORDIC OP-1 MINIMALIST DECK */}
        {skin === "nordic-op1" && (
          <div className="nordic-top-deck">
            <div className="nordic-top-left-cluster">
              <NordicSpeakerGrille />
              <div className="nordic-oled-display-unit">
                <div className="nordic-oled-top-meta-row">
                  <span>ECHOLET OP-1</span>
                  <span>{currentTimeStr} UTC</span>
                  <span>● SIGNAL LOCK</span>
                </div>
                <div className="nordic-oled-center-freq-row">
                  <span className="nordic-oled-freq-large">{freqVal.toFixed(3)} MHz</span>
                  <span className="nordic-oled-band-tag">{activeChannel}</span>
                </div>
                <canvas ref={nordicCanvasRef} width={300} height={22} className="nordic-live-spectrum-canvas" />
              </div>
            </div>

            <div className="nordic-pushbuttons-row">
              <button
                className="nordic-rubber-circle-btn btn-orange"
                onClick={() => switchChannel("CH 1-9")}
                title="Channel 1 (7.100 MHz)"
              />
              <button
                className="nordic-rubber-circle-btn btn-ochre"
                onClick={() => switchChannel("HAM Radio")}
                title="Channel 2 (14.200 MHz)"
              />
              <button
                className="nordic-rubber-circle-btn btn-cyan"
                onClick={() => switchChannel("Weather")}
                title="Channel 3 (146.520 MHz)"
              />
              <button
                className="nordic-rubber-circle-btn btn-white"
                onClick={() => switchChannel("VHF/UHF")}
                title="Channel 4 (433.500 MHz)"
              />
            </div>

            <div className="nordic-selector-unit">
              <select
                className="nordic-clean-select"
                value={skin}
                onChange={(e) => handleSkinChange(e.target.value as SkinId)}
              >
                <option value="nordic-op1">🎹 Nordic Minimalist (OP-1)</option>
                <option value="vintage-radiola">📻 Vintage Radiola 1950</option>
                <option value="military-r250">🎖️ Военный Р-250 «Кит»</option>
                <option value="audiophile-hifi">🎵 Hi-Fi McIntosh Tube Amp</option>
                <option value="oscilloscope-crt">🔬 Ламповый осциллограф ЭЛТ</option>
                <option value="nixie-tube">🔢 Nixie & Tube HUD (ИН-14)</option>
              </select>
            </div>
          </div>
        )}

        {/* =========================================================================
            MAIN CHASSIS: 3 PHYSICAL ZONES
           ========================================================================= */}
        <div className="radio-main-body">

          {/* -----------------------------------------------------------------------
              ZONE 1 (LEFT): CHANNELS & CONTACTS
             ----------------------------------------------------------------------- */}
          <aside className="hardware-contacts-zone">
            {skin === "vintage-radiola" && (
              <div className="radiola-vertical-brass-rails">
                <div className="brass-rail" />
                <div className="brass-rail" />
                <div className="brass-rail" />
              </div>
            )}

            <div className="contacts-zone-header">
              {skin === "military-r250" ? "ОПЕРАТОРЫ РАДИОСВЯЗИ" :
               skin === "vintage-radiola" ? "STATIONS & OPERATORS" :
               skin === "audiophile-hifi" ? "CONTACTS" :
               skin === "nordic-op1" ? "CHANNELS & STATIONS" :
               "CHANNELS IN AIR"}
            </div>

            <div className="contacts-items-container">
              {filteredContacts.length === 0 ? (
                <div className="empty-contacts-badge">
                  {skin === "military-r250" ? "НЕТ ДАННЫХ В КАРТОТЕКЕ" : "No stations found"}
                </div>
              ) : (
                filteredContacts.map((contact) => {
                  const isSelected = selectedContact?.identity_id === contact.identity_id;
                  const shortId = contact.identity_id.substring(0, 8);
                  const displayName =
                    contact.name ||
                    (skin === "vintage-radiola" ? `Station ${shortId.toUpperCase()}` :
                     skin === "military-r250" ? `R-45 / ${shortId.toUpperCase()}` :
                     `Call-${shortId.toUpperCase()}`);

                  return (
                    <div
                      key={contact.identity_id}
                      className={`hardware-contact-card ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedContact(contact);
                        playHardwareClick("soft");
                      }}
                    >
                      {skin === "military-r250" && (
                        <div className="mil-wire-terminal">
                          <div className="terminal-screw" />
                          <div className="copper-wire" />
                        </div>
                      )}

                      {skin === "vintage-radiola" && <div className="plaque-screw left" />}

                      <div className="contact-details-box">
                        <div className="contact-title-row">
                          <span className="contact-bold-name">{displayName}</span>
                          {skin === "military-r250" && <span className="mil-onair-tag">В ЭФИРЕ</span>}
                        </div>
                        <div className="contact-sub-id">{contact.identity_id.substring(0, 14)}…</div>
                      </div>

                      <div className={`contact-status-lamp ${isSelected ? "active" : ""}`} />

                      {skin === "vintage-radiola" && <div className="plaque-screw right" />}
                    </div>
                  );
                })
              )}
            </div>

            <div className="contacts-bottom-actions">
              <button className="hardware-action-button" onClick={() => setShowImportModal(true)}>
                {skin === "military-r250" ? "+ ДОБАВИТЬ КАРТОЧКУ" :
                 skin === "vintage-radiola" ? "+ Add Radio Card" :
                 "+ Add Contact"}
              </button>
              <button className="hardware-action-button secondary" onClick={handleExportCard}>
                {skin === "military-r250" ? "ЭКСПОРТ КАРТОЧКИ" : "Export Card"}
              </button>
            </div>
          </aside>

          {/* -----------------------------------------------------------------------
              ZONE 2 (CENTER): CHAT MESSAGES SCREEN
             ----------------------------------------------------------------------- */}
          <main className="hardware-chat-zone">
            {skin === "military-r250" && (
              <>
                <div className="crt-grab-handle crt-handle-left" />
                <div className="crt-grab-handle crt-handle-right" />
              </>
            )}

            {selectedContact ? (
              <>
                <div className="chat-top-bezel">
                  <div className="chat-header-info">
                    <span className="chat-peer-title">
                      {skin === "military-r250" ? `ОПЕРАТОР: ${(selectedContact.name || selectedContact.identity_id).substring(0, 14).toUpperCase()}` :
                       `CALLSIGN: ${(selectedContact.name || selectedContact.identity_id).substring(0, 14).toUpperCase()}`}
                    </span>
                    <span className="chat-e2ee-hash">RATC-KEY: {selectedContact.identity_id.substring(0, 24)}…</span>
                  </div>

                  <div className="chat-auth-badges">
                    {skin === "military-r250" ? (
                      <div className="flex gap-2">
                        <SecretRubberStamp text="СЕКРЕТНО" />
                        <SecretRubberStamp text="ЗАШИФРОВАНО" />
                      </div>
                    ) : skin === "vintage-radiola" ? (
                      <WaxSeal text="E2EE" />
                    ) : (
                      <span className="hifi-protocol-badge">🔒 DOUBLE RATCHET E2EE</span>
                    )}
                  </div>
                </div>

                <div className="chat-messages-container">
                  {(skin === "military-r250" || skin === "oscilloscope-crt") && (
                    <div className="crt-scanline-grid" />
                  )}

                  {activeTraffic.length === 0 ? (
                    <div className="empty-ether-notice">
                      <div className="ether-icon">📻</div>
                      <div className="ether-bold">ЭФИР ЧИСТ. СООБЩЕНИЙ НЕТ.</div>
                      <div className="ether-sub">Наберите текст внизу для отправки зашифрованной радиограммы.</div>
                    </div>
                  ) : (
                    activeTraffic.map((msg, idx) => {
                      const time = new Date(msg.createdAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      const isOut = msg.direction === "outbound";
                      return (
                        <div key={idx} className={`hardware-msg-row ${isOut ? "outbound" : "inbound"}`}>
                          {skin === "vintage-radiola" && !isOut && (
                            <div className="radiola-msg-toggle-widget received">
                              <div className="toggle-brass-knob" />
                              <span className="toggle-state-text">Received</span>
                            </div>
                          )}

                          <div className="hardware-msg-bubble">
                            {skin === "military-r250" && (
                              <div className="mil-teletype-stamp-header">
                                <span className="mil-stamp-tag">{isOut ? "[ПЕРЕДАНО]" : "[ПРИНЯТО]"}</span>
                                <span className="mil-stamp-time">[{time}]</span>
                              </div>
                            )}

                            <div className="hardware-msg-text">{msg.plaintext}</div>

                            <div className="hardware-msg-meta">
                              <span className="msg-timestamp">{time}</span>
                              <span className={`msg-status-indicator ${isOut ? "sent" : "rcvd"}`}>
                                {isOut ? "● [ДОСТАВЛЕНО]" : "● [ПРИНЯТО]"}
                              </span>
                            </div>
                          </div>

                          {skin === "vintage-radiola" && isOut && (
                            <div className="radiola-msg-toggle-widget sent">
                              <div className="toggle-brass-knob on" />
                              <span className="toggle-state-text">Sent</span>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="hardware-input-deck">
                  <form className="hardware-input-form" onSubmit={handleSend}>
                    <input
                      type="text"
                      className="hardware-input-field"
                      placeholder={
                        skin === "military-r250"
                          ? "ТЕКСТ ТАКТИЧЕСКОГО СООБЩЕНИЯ (Enter для передачи в эфир)..."
                          : "Type message to transmit into the air..."
                      }
                      value={inputMsg}
                      onChange={(e) => setInputMsg(e.target.value)}
                      disabled={sending}
                    />
                    <button
                      type="submit"
                      className="hardware-transmit-button"
                      disabled={!inputMsg.trim() || sending}
                    >
                      {sending ? "TRANSMITTING..." : skin === "military-r250" ? "ПЕРЕДАТЬ ⚡" : "TRANSMIT 📻"}
                    </button>
                  </form>
                </div>
              </>
            ) : (
              <div className="empty-ether-notice">
                <div className="ether-icon">📻</div>
                <div className="ether-bold">ВЫБЕРИТЕ СТАНЦИЮ АБОНЕНТА</div>
                <div className="ether-sub">Шифрование Double Ratchet активно на вашем узле</div>
              </div>
            )}
          </main>

          {/* -----------------------------------------------------------------------
              ZONE 3 (RIGHT): HARDWARE CONTROLS
             ----------------------------------------------------------------------- */}
          <aside className="hardware-controls-zone">
            <div className="controls-zone-header">
              {skin === "military-r250" ? "НАСТРОЙКА И КОНТРОЛЬ" :
               skin === "vintage-radiola" ? "TUNING & OUTPUT" :
               skin === "audiophile-hifi" ? "AUDIO CONTROLS" :
               skin === "nordic-op1" ? "HARDWARE ENCODERS" :
               "HARDWARE RACK"}
            </div>

            {skin === "vintage-radiola" && (
              <div className="radiola-right-hardware-layout">
                <div className="radiola-verniers-column">
                  <div className="radiola-vernier-card">
                    <RotaryKnob label="VERNIER" value={65} size={64} material="brass" />
                  </div>
                  <div className="radiola-vernier-card">
                    <RotaryKnob label="VERNIER DIAL" value={35} size={64} material="brass" />
                  </div>
                </div>

                <RadiolaDualTubesAlcove />

                <div className="radiola-bottom-mini-knobs">
                  <RotaryKnob label="Prefs" value={50} size={36} material="brass" />
                  <RotaryKnob label="Toggle" value={80} size={36} material="brass" />
                  <RotaryKnob label="Audio" value={60} size={36} material="brass" />
                </div>
              </div>
            )}

            {skin === "military-r250" && (
              <div className="military-right-hardware-layout">
                <div className="mil-knobs-row">
                  <RotaryKnob label="ГР. ЧАСТОТА" value={70} size={54} material="bakelite" />
                  <RotaryKnob label="ТОН. НАСТРОЙКА" value={45} size={54} material="bakelite" />
                </div>

                <div className="mil-vernier-gear-box">
                  <span className="vernier-gear-title">VERNIER REDUCTION GEAR</span>
                  <div className="vernier-slider-track">
                    <div className="vernier-thumbwheel" />
                    <div className="vernier-scale-ticks">| | | | | | | | | |</div>
                  </div>
                </div>

                <SovietCathodeIndicatorBar />

                <div className="mil-bottom-controls-row">
                  <RotaryKnob label="РРУ" value={60} size={38} material="bakelite" />
                  <RotaryKnob label="ШП" value={30} size={38} material="bakelite" />
                </div>
              </div>
            )}

            {skin === "audiophile-hifi" && (
              <div className="hifi-right-hardware-layout">
                <div className="hifi-gold-knobs-row">
                  <RotaryKnob label="VOLUME" value={75} size={56} material="brass" />
                  <RotaryKnob label="SQUELCH" value={40} size={56} material="brass" />
                </div>

                <McIntoshBiasWindow />
                <McIntoshGoldBindingPosts />
              </div>
            )}

            {skin === "oscilloscope-crt" && (
              <div className="crt-right-hardware-layout">
                <AnalogMeter label="S-METER" unit="RF LEVEL" value={8} min={0} max={10} styleType="amber" width={140} height={76} />
                <RotaryKnob label="CALIBRATOR" value={60} size={58} material="silver" />
                <div className="telemetry-mini-stream">
                  <div className="term-stream-title">SIGNAL MONITOR</div>
                  <div className="term-stream-box">
                    {telemetry.slice(-6).map((t, idx) => (
                      <div key={idx} className={`term-msg-line ${t.type}`}>
                        {t.time ? t.time.split("T")[1]?.substring(0, 8) : ""} {t.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {skin === "nixie-tube" && (
              <div className="nixie-right-hardware-layout">
                <div className="nixie-meters-row">
                  <AnalogMeter label="BIAS L" unit="mA" value={45} min={0} max={100} styleType="amber" width={110} height={68} />
                  <AnalogMeter label="BIAS R" unit="mA" value={48} min={0} max={100} styleType="amber" width={110} height={68} />
                </div>
                <div className="nixie-knobs-row">
                  <RotaryKnob label="VOLUME" value={70} size={48} material="brass" />
                  <RotaryKnob label="SQUELCH" value={35} size={48} material="brass" />
                </div>
                <div className="telemetry-mini-stream">
                  <div className="term-stream-title">TELEMETRY LOG</div>
                  <div className="term-stream-box">
                    {telemetry.slice(-5).map((t, idx) => (
                      <div key={idx} className={`term-msg-line ${t.type}`}>
                        {t.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {skin === "nordic-op1" && (
              <div className="nordic-right-hardware-layout">
                <div className="nordic-encoders-2x2">
                  <NordicRotaryEncoder
                    label="Volume"
                    value={knobVol}
                    color="#0284c7"
                    onClick={() => cycleKnob("vol")}
                  />
                  <NordicRotaryEncoder
                    label="Squelch"
                    value={knobG}
                    color="#16a34a"
                    onClick={() => cycleKnob("g")}
                  />
                  <NordicRotaryEncoder
                    label="RF Gain"
                    value={knobGain}
                    color="#d97706"
                    onClick={() => cycleKnob("gain")}
                  />
                  <NordicRotaryEncoder
                    label="Tune"
                    value={knobTune}
                    color="#ea580c"
                    onClick={() => cycleKnob("tune")}
                  />
                </div>

                <div className="nordic-jog-section">
                  <NordicJogDial
                    angle={jogAngle}
                    onRotate={() => {
                      setJogAngle((a) => (a + 30) % 360);
                      playHardwareClick("soft");
                    }}
                  />
                  <span className="nordic-jog-label">ROTARY JOG WHEEL</span>
                </div>

                <div className="telemetry-mini-stream">
                  <div className="term-stream-title">OP-1 PACKET TELEMETRY</div>
                  <div className="term-stream-box">
                    {telemetry.slice(-5).map((t, idx) => (
                      <div key={idx} className={`term-msg-line ${t.type}`}>
                        {t.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* MODALS */}
      {showImportModal && (
        <div className="hardware-modal-overlay">
          <div className="hardware-modal-card">
            <div className="hardware-modal-header">
              <span>ИМПОРТ РАДИО-КАРТОЧКИ АБОНЕНТА</span>
              <button className="modal-close-btn" onClick={() => setShowImportModal(false)}>✕</button>
            </div>
            <div className="hardware-modal-body">
              <p className="modal-help-text">Вставьте JSON-карточку абонента (public identity key & prekeys):</p>
              <textarea
                className="modal-json-textarea"
                placeholder='{"identity_id": "...", "signal_identity_key": "...", ...}'
                value={importJsonText}
                onChange={(e) => setImportJsonText(e.target.value)}
              />
            </div>
            <div className="hardware-modal-footer">
              <button className="hardware-btn-secondary" onClick={() => setShowImportModal(false)}>Отмена</button>
              <button className="hardware-btn-primary" onClick={handleImportCard}>Импортировать</button>
            </div>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="hardware-modal-overlay">
          <div className="hardware-modal-card">
            <div className="hardware-modal-header">
              <span>ВАША РАДИО-КАРТОЧКА (ЭКСПОРТ)</span>
              <button className="modal-close-btn" onClick={() => setShowExportModal(false)}>✕</button>
            </div>
            <div className="hardware-modal-body">
              <p className="modal-help-text">Передайте эти публичные ключи собеседнику для шифрования сообщений:</p>
              <textarea className="modal-json-textarea" readOnly value={exportJsonText} />
            </div>
            <div className="hardware-modal-footer">
              <button
                className="hardware-btn-primary"
                onClick={() => {
                  navigator.clipboard.writeText(exportJsonText);
                  alert("Скопировано в буфер обмена!");
                }}
              >
                Скопировать в буфер
              </button>
              <button className="hardware-btn-secondary" onClick={() => setShowExportModal(false)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

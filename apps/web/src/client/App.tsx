import React, { useState, useEffect, useRef } from "react";
import { ModalDialog } from "./ModalDialog";
import { MAX_CONTACT_CARD_BYTES, type ContactCardPreview, isDuplicateContact, parseContactCard, parseExportCardResponse } from "./contactCard";
import { effectiveRelayState, isRecord, parseStationStatus, type ConnectionState, type ProfileState, type ReachabilityState } from "./stationStatus";
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

function mapContacts(value: unknown): Contact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.identity_id !== "string" || typeof item.device_id !== "string") return [];
    return [{
      identity_id: item.identity_id,
      device_id: item.device_id,
      device_pubkey: typeof item.device_pubkey === "string" ? item.device_pubkey : undefined,
      signal_identity_key: typeof item.signal_identity_key === "string" ? item.signal_identity_key : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
    }];
  });
}

function isTelemetryItem(value: unknown): value is TelemetryItem {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.time === "string" &&
    typeof value.message === "string" &&
    (value.type === "info" || value.type === "success" || value.type === "warn" || value.type === "error" || value.type === "crypto");
}

/* Legacy demo fixtures intentionally disabled: real contacts and history only come from the bridge.
const DEFAULT_CONTACTS: Contact[] = [
  { identity_id: "atk7QgkCcCVIuvicT0gqmwQOZMbS9ygmjtRws_7xrgY", name: "Elsa Larsson", device_id: "unused" }
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

void [DEFAULT_CONTACTS, DEFAULT_HISTORY, DEFAULT_RADIOLA_TRAFFIC, DEFAULT_MILITARY_TRAFFIC];
*/

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
  const [relayUrl, setRelayUrl] = useState<string>("");
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [relayState, setRelayState] = useState<ConnectionState>("unknown");
  const [localStationState, setLocalStationState] = useState<ConnectionState>("unknown");
  const [profileState, setProfileState] = useState<ProfileState>("unknown");
  const [relayReachability, setRelayReachability] = useState<ReachabilityState>("unknown");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryItem[]>([]);
  const [inputMsg, setInputMsg] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [searchQuery] = useState<string>("");

  // Nordic Winamp State
  const [freqVal, setFreqVal] = useState<number>(7.100);
  const [activeChannel, setActiveChannel] = useState<string>("CH 1-9");
  const [jogAngle, setJogAngle] = useState<number>(45);
  const [knobVol, setKnobVol] = useState<number>(50);
  const [knobG, setKnobG] = useState<number>(30);
  const [knobGain, setKnobGain] = useState<number>(70);
  const [knobTune, setKnobTune] = useState<number>(110);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("14:32");

  useEffect(() => {
    const updateTimes = () => {
      const d = new Date();
      setCurrentTimeStr(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    };
    updateTimes();
    const t = setInterval(updateTimes, 10000);
    return () => clearInterval(t);
  }, []);

  const switchChannel = (ch: string) => {
    setActiveChannel(ch);
    playHardwareClick("soft");
    if (ch === "CH 1-9") setFreqVal(7.100);
    else if (ch === "HAM Radio") setFreqVal(14.200);
    else if (ch === "Weather") setFreqVal(146.520);
    else if (ch === "VHF/UHF") setFreqVal(433.500);
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
  const [importPreview, setImportPreview] = useState<ContactCardPreview | null>(null);
  const [validatedCard, setValidatedCard] = useState<Record<string, unknown> | null>(null);
  const [importError, setImportError] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [validatingImport, setValidatingImport] = useState(false);
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportJsonText, setExportJsonText] = useState<string>("");
  const [exportError, setExportError] = useState<string>("");
  const [exportLoading, setExportLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const crtCanvasRef = useRef<HTMLCanvasElement>(null);
  const nordicCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedContactRef = useRef<Contact | null>(null);
  const historyRequestRef = useRef(0);
  const exportRequestRef = useRef(0);
  const importGenerationRef = useRef(0);

  const handleSkinChange = (newSkin: SkinId) => {
    setSkin(newSkin);
    localStorage.setItem("echolet_skin", newSkin);
  };

  // 1. Initial Load
  const applyStatus = (payload: unknown) => {
    const status = parseStationStatus(payload);
    if (!status) return;
    if (status.label !== null) setLabel(status.label);
    setRelayUrl(status.relayUrl);
    setPingMs(status.pingMs);
    setRelayState(status.relay);
    setProfileState(status.profileState);
    setRelayReachability(status.relayReachability);
    if (status.telemetry) setTelemetry(status.telemetry.filter(isTelemetryItem));

    const mapped = mapContacts(status.profile?.contacts);
    setContacts(mapped);
    const selectedId = selectedContactRef.current?.identity_id;
    const nextSelected = mapped.find((contact) => contact.identity_id === selectedId) ?? mapped[0] ?? null;
    selectedContactRef.current = nextSelected;
    setSelectedContact(nextSelected);
    if (!nextSelected) setHistory([]);
  };

  const loadStatus = async () => {
    try {
      const res = await fetch("/api/status");
      applyStatus(await res.json());
    } catch (e) {
      console.error("Failed to load status", e);
    }
  };

  const loadHistory = async (contactId: string) => {
    const requestId = ++historyRequestRef.current;
    try {
      const res = await fetch(`/api/history?with=${encodeURIComponent(contactId)}`);
      const data = await res.json();
      if (data.ok && data.data?.entries && selectedContactRef.current?.identity_id === contactId && requestId === historyRequestRef.current) {
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
      selectedContactRef.current = selectedContact;
      loadHistory(selectedContact.identity_id);
    }
  }, [selectedContact]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // 2. CRT Oscilloscope Canvas Animation
  useEffect(() => {
    if (skin !== "oscilloscope-crt" || !crtCanvasRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
    if (skin !== "nordic-op1" || !nordicCanvasRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
    sse.addEventListener("open", () => setLocalStationState("connected"));
    sse.addEventListener("error", () => setLocalStationState("disconnected"));
    sse.addEventListener("status", (e) => {
      try {
        applyStatus(JSON.parse(e.data));
      } catch (error) {
        console.error("Failed to read station status event", error);
      }
    });
    sse.addEventListener("telemetry", (e) => {
      try {
        const item: TelemetryItem = JSON.parse(e.data);
        setTelemetry((prev) => [...prev.slice(-150), item]);
      } catch (error) {
        console.error("Failed to read telemetry event", error);
      }
    });
    sse.addEventListener("ping", (e) => {
      try {
        const data = JSON.parse(e.data);
        setPingMs(data.ping);
      } catch (error) {
        console.error("Failed to read ping event", error);
      }
    });
    sse.addEventListener("new_message", () => {
      const selected = selectedContactRef.current;
      if (selected) loadHistory(selected.identity_id);
    });
    sse.addEventListener("outbound_sent", () => {
      const selected = selectedContactRef.current;
      if (selected) loadHistory(selected.identity_id);
    });
    sse.addEventListener("contact_added", () => {
      loadStatus();
    });
    return () => sse.close();
  }, []);

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
    const requestId = ++exportRequestRef.current;
    setShowExportModal(true);
    setExportLoading(true);
    setExportError("");
    setExportJsonText("");
    setCopyStatus("");
    try {
      const res = await fetch("/api/contacts/export");
      const text = await res.text();
      const exported = parseExportCardResponse(res.status, text);
      if (!exported.ok) {
        throw new Error(exported.error);
      }
      if (requestId === exportRequestRef.current) setExportJsonText(exported.cardJson);
    } catch (error) {
      if (requestId === exportRequestRef.current) {
        setExportError(error instanceof Error ? error.message : "Не удалось экспортировать карточку.");
      }
    } finally {
      if (requestId === exportRequestRef.current) setExportLoading(false);
    }
  };

  const resetImportPreparation = () => {
    importGenerationRef.current++;
    setValidatingImport(false);
    setImportPreview(null);
    setValidatedCard(null);
    setImportError("");
  };

  const handleImportTextChange = (value: string) => {
    setImportJsonText(value);
    resetImportPreparation();
  };

  const handleImportFile = async (file: File | undefined) => {
    resetImportPreparation();
    const generation = importGenerationRef.current;
    if (!file) return;
    if (file.size > MAX_CONTACT_CARD_BYTES) {
      setImportError("Карточка превышает допустимый размер 128 КБ.");
      return;
    }
    try {
      const text = await file.text();
      if (generation !== importGenerationRef.current) return;
      setImportJsonText(text);
    } catch {
      if (generation === importGenerationRef.current) {
        setImportError("Не удалось прочитать выбранный файл карточки.");
      }
    }
  };

  const handleValidateImport = async () => {
    const generation = ++importGenerationRef.current;
    setImportPreview(null);
    setValidatedCard(null);
    setImportError("");
    const parsed = parseContactCard(importJsonText);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    if (isDuplicateContact(parsed.preview, contacts.map((contact) => contact.identity_id))) {
      setImportError("Этот абонент уже есть в адресной книге.");
      return;
    }
    setValidatingImport(true);
    try {
      const res = await fetch("/api/contacts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardJson: parsed.card }),
      });
      const data: unknown = await res.json();
      if (!res.ok || !isRecord(data) || data.ok !== true) {
        throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : "Карточка не прошла криптографическую проверку.");
      }
      if (generation !== importGenerationRef.current) return;
      setImportPreview(parsed.preview);
      setValidatedCard(parsed.card);
    } catch (error) {
      if (generation !== importGenerationRef.current) return;
      setImportError(error instanceof Error ? error.message : "Не удалось проверить карточку.");
    } finally {
      if (generation === importGenerationRef.current) setValidatingImport(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!validatedCard || importing) return;
    const current = parseContactCard(importJsonText);
    if (!current.ok || JSON.stringify(current.card) !== JSON.stringify(validatedCard)) {
      setImportError("Карточка изменилась. Проверьте её повторно перед импортом.");
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardJson: validatedCard, confirmed: true }),
      });
      const data: unknown = await res.json();
      if (!res.ok || !isRecord(data) || data.ok !== true) {
        throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : "Не удалось импортировать карточку.");
      }
      importGenerationRef.current++;
      setShowImportModal(false);
      setImportJsonText("");
      resetImportPreparation();
      await loadStatus();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Не удалось импортировать карточку.");
    } finally {
      setImporting(false);
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

  const activeTraffic = history;
  const displayedRelayState = effectiveRelayState(localStationState, relayState);
  const relayLabel = displayedRelayState === "connected"
    ? "Соединение с relay подтверждено"
    : localStationState === "disconnected"
      ? "Локальная станция недоступна"
      : displayedRelayState === "disconnected"
        ? "Соединение с relay отключено"
      : "Состояние relay неизвестно";
  const closeImportModal = () => {
    resetImportPreparation();
    setShowImportModal(false);
  };
  const profileLabel = profileState === "verified"
    ? "Профиль готов"
    : profileState === "unverified"
      ? "Профиль требует проверки"
      : "Состояние профиля неизвестно";
  const closeExportModal = () => {
    exportRequestRef.current++;
    setShowExportModal(false);
  };

  return (
    <div className={`radio-outer-wrap skin-${skin}`} data-theme={skin}>
      {/* SKEUOMORPHIC CABINET CONTAINER */}
      <div className="radio-cabinet">
        <section className="station-status" data-state={displayedRelayState} aria-label="Состояние станции">
          <span className="station-status-label">{relayLabel}</span>
          <span className="station-profile-status" data-state={profileState}>{profileLabel}</span>
          <span className="station-status-label" title={relayUrl}>
            Доступность relay: {relayReachability === "reachable" ? "доступен" : relayReachability === "unreachable" ? "недоступен" : "неизвестна"}
          </span>
          <span className="station-status-label">Оператор: {label}</span>
        </section>

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
                  className="brass-toggle-lever on"
                  aria-hidden="true"
                >
                  <div className="lever-nut" />
                  <div className="lever-arm" />
                </div>
                <span className="toggle-sub-label">ВИЗУАЛЬНО</span>
              </div>

              <div className="radiola-skin-selector-bezel">
                <span className="radiola-selector-title">DIAL SKIN</span>
                <span className="station-theme-field">Оформление</span>
                <select
                  className="radiola-wood-select station-theme-field"
                  aria-label="Оформление"
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
                <div className="mil-bat-switch" aria-hidden="true">
                  <span className="mil-jewel-lamp on" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">СЕТЬ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" aria-hidden="true">
                  <span className="mil-jewel-lamp on" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">ВЧ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" aria-hidden="true">
                  <span className="mil-jewel-lamp active" />
                  <div className="bat-toggle-stick" />
                  <span className="bat-label">НЧ ВКЛ</span>
                </div>
                <div className="mil-bat-switch" aria-hidden="true">
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
                <span className="station-theme-field">Оформление</span>
                <select
                  className="military-bakelite-select station-theme-field"
                  aria-label="Оформление"
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
              <span className="station-theme-field">Оформление</span>
              <select
                className="hifi-gold-select station-theme-field"
                aria-label="Оформление"
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
              <span className="station-theme-field">Оформление</span>
              <select
                className="crt-dark-select station-theme-field"
                aria-label="Оформление"
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
              <span className="station-theme-field">Оформление</span>
              <select
                className="nixie-dark-select station-theme-field"
                aria-label="Оформление"
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
                  <span>ВИЗУАЛЬНАЯ СИМУЛЯЦИЯ</span>
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
              <span className="station-theme-field">Оформление</span>
              <select
                className="nordic-clean-select station-theme-field"
                aria-label="Оформление"
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
                <div className="empty-contacts-badge station-empty-state">
                  {contacts.length === 0
                    ? (skin === "military-r250"
                        ? "КАРТОТЕКА ПУСТА. ДОБАВЬТЕ КАРТОЧКУ АБОНЕНТА."
                        : "No contacts yet. Add a contact card to start.")
                    : "Нет подходящих контактов"}
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
                    <button
                      type="button"
                      key={contact.identity_id}
                      className={`hardware-contact-card ${isSelected ? "selected" : ""}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        selectedContactRef.current = contact;
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
                        </div>
                        <div className="contact-sub-id">{contact.identity_id.substring(0, 14)}…</div>
                      </div>

                      <div className={`contact-status-lamp ${isSelected ? "active" : ""}`} aria-hidden="true" />

                      {skin === "vintage-radiola" && <div className="plaque-screw right" />}
                    </button>
                  );
                })
              )}
            </div>

            <div className="contacts-bottom-actions">
              <button className="hardware-action-button" onClick={() => setShowImportModal(true)}>
                Добавить контакт
              </button>
              <button className="hardware-action-button secondary" onClick={handleExportCard}>
                Поделиться моей карточкой
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
              <div className="empty-ether-notice station-empty-state">
                <div className="ether-icon">📻</div>
                <div className="ether-bold">
                  {contacts.length === 0
                    ? "Контактов пока нет"
                    : "Выберите контакт"}
                </div>
                <div className="ether-sub">
                  {contacts.length === 0
                    ? "Импортируйте карточку абонента или передайте свою карточку собеседнику."
                    : "Выберите контакт, чтобы увидеть переписку."}
                </div>
                {contacts.length === 0 && (
                  <div className="station-empty-actions">
                    <button type="button" className="hardware-action-button" onClick={() => setShowImportModal(true)}>Добавить контакт</button>
                    <button type="button" className="hardware-action-button secondary" onClick={handleExportCard}>Поделиться моей карточкой</button>
                  </div>
                )}
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
            <p className="hardware-simulation-note">Частоты и регуляторы ниже — визуальная симуляция.</p>

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
        <ModalDialog title="Импорт карточки абонента" titleId="import-card-title" onClose={() => !importing && closeImportModal()}>
          <div className="hardware-modal-body">
            <p className="modal-help-text">Выберите файл или вставьте JSON-карточку. Импорт начнётся только после проверки и подтверждения.</p>
            <label htmlFor="contact-card-file">Файл карточки</label>
            <input
              id="contact-card-file"
              type="file"
              accept="application/json,.json"
              disabled={importing || validatingImport}
              onChange={(event) => void handleImportFile(event.currentTarget.files?.[0])}
            />
            <label htmlFor="contact-card-json">JSON карточки</label>
            <textarea
              id="contact-card-json"
              className="modal-json-textarea"
              placeholder='{"type":"echolet_contact_card", ...}'
              value={importJsonText}
              disabled={importing || validatingImport}
              aria-describedby={importError ? "import-card-error" : undefined}
              onChange={(event) => handleImportTextChange(event.target.value)}
            />
            {importError && <p id="import-card-error" className="dialog-error" role="alert">{importError}</p>}
            {importPreview && (
              <div className="card-preview" aria-live="polite">
                <strong>Карточка проверена и готова к импорту</strong>
                <span>Identity: {importPreview.identityId}</span>
                <span>Устройство: {importPreview.deviceId}</span>
              </div>
            )}
          </div>
          <div className="hardware-modal-footer dialog-actions">
            <button type="button" className="hardware-btn-secondary" disabled={importing} onClick={closeImportModal}>Отмена</button>
            <button type="button" className="hardware-btn-secondary" disabled={importing || validatingImport} onClick={() => void handleValidateImport()}>{validatingImport ? "Проверяем…" : "Проверить карточку"}</button>
            <button type="button" className="hardware-btn-primary" disabled={!validatedCard || importing || validatingImport} onClick={() => void handleConfirmImport()}>
              {importing ? "Импортируется…" : "Подтвердить импорт"}
            </button>
          </div>
        </ModalDialog>
      )}

      {showExportModal && (
        <ModalDialog
          title="Моя карточка"
          titleId="export-card-title"
          onClose={closeExportModal}
        >
          <div className="hardware-modal-body">
            <p className="modal-help-text">Передайте эту публичную карточку собеседнику для защищённой переписки.</p>
            {exportLoading && <p aria-live="polite">Подготавливаем карточку…</p>}
            {exportError && <p className="dialog-error" role="alert">{exportError}</p>}
            {!exportLoading && !exportError && exportJsonText && (
              <textarea className="modal-json-textarea" aria-label="JSON моей карточки" readOnly value={exportJsonText} />
            )}
            {copyStatus && <p aria-live="polite">{copyStatus}</p>}
          </div>
          <div className="hardware-modal-footer dialog-actions">
            {exportError && <button type="button" className="hardware-btn-primary" onClick={handleExportCard}>Повторить экспорт</button>}
            {exportJsonText && (
              <button
                type="button"
                className="hardware-btn-primary"
                onClick={() => void (async () => {
                  try {
                    if (!navigator.clipboard) throw new Error("Clipboard API недоступен");
                    await navigator.clipboard.writeText(exportJsonText);
                    setCopyStatus("Карточка скопирована в буфер обмена.");
                  } catch {
                    setCopyStatus("Не удалось скопировать карточку. Скопируйте текст вручную.");
                  }
                })()}
              >
                Скопировать в буфер
              </button>
            )}
            <button type="button" className="hardware-btn-secondary" onClick={closeExportModal}>Закрыть</button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

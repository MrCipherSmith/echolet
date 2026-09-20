import React from "react";

// ============================================================================
// 1. DUAL MCINTOSH BLUE VU-METERS (ICONIC RECTANGULAR OCEANIC-BLUE GAUGES)
// ============================================================================
export function McIntoshVUPair({
  leftVal = 5,
  rightVal = 6,
}: {
  leftVal?: number;
  rightVal?: number;
}) {
  const renderMeter = (val: number, chName: string) => {
    // scale: -20 to +10 dB
    const pct = Math.max(0, Math.min(1, (val - -20) / 30));
    const angle = -42 + pct * 84;
    const rad = (angle * Math.PI) / 180;
    const cx = 85;
    const cy = 88;
    const len = 68;
    const tx = cx + Math.sin(rad) * len;
    const ty = cy - Math.cos(rad) * len;

    return (
      <div
        style={{
          width: 176,
          height: 104,
          background: "radial-gradient(ellipse at 50% 120%, #38bdf8 0%, #0284c7 40%, #034e7a 80%, #082f49 100%)",
          border: "4px solid #0f172a",
          borderRadius: 6,
          boxShadow: "0 0 22px rgba(56, 189, 248, 0.45), inset 0 2px 10px rgba(0,0,0,0.85)",
          position: "relative",
          overflow: "hidden",
          userSelect: "none",
        }}
      >
        {/* Glass reflection highlight */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "42%",
            background: "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 100%)",
            pointerEvents: "none",
          }}
        />

        <svg viewBox="0 0 170 95" style={{ width: "100%", height: "100%" }}>
          {/* Main Arc */}
          <path
            d="M 22 78 A 76 76 0 0 1 148 78"
            fill="none"
            stroke="#f0f9ff"
            strokeWidth="2.2"
            strokeOpacity="0.95"
          />

          {/* Scale ticks */}
          {[-40, -28, -16, -6, 4, 14, 24, 34, 42].map((deg, i) => {
            const r = (deg * Math.PI) / 180;
            const x1 = cx + Math.sin(r) * 70;
            const y1 = cy - Math.cos(r) * 70;
            const x2 = cx + Math.sin(r) * 78;
            const y2 = cy - Math.cos(r) * 78;
            const isRed = deg >= 14;
            const textLabels = ["-20", "-12", "-6", "-3", "-1", "0", "+1", "+2", "+10"];
            const lx = cx + Math.sin(r) * 59;
            const ly = cy - Math.cos(r) * 59;

            return (
              <g key={i}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isRed ? "#ef4444" : "#f0f9ff"}
                  strokeWidth={i === 5 ? 2.5 : 1.4}
                />
                <text
                  x={lx}
                  y={ly + 3}
                  fill={isRed ? "#ef4444" : "#f0f9ff"}
                  fontSize="7"
                  fontFamily="'Times New Roman', serif"
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {textLabels[i]}
                </text>
              </g>
            );
          })}

          {/* Center dB */}
          <text
            x="85"
            y="46"
            fill="#e0f2fe"
            fontSize="11"
            fontFamily="'Times New Roman', serif"
            fontWeight="bold"
            textAnchor="middle"
            letterSpacing="1"
          >
            dB
          </text>

          {/* Left/Right channel labels */}
          <text x="32" y="78" fill="#bae6fd" fontSize="7.5" fontFamily="sans-serif" fontWeight="bold">
            {chName === "L" ? "L CH" : "R CH"}
          </text>
          <text x="138" y="78" fill="#bae6fd" fontSize="7.5" fontFamily="sans-serif" fontWeight="bold">
            {chName === "L" ? "R CH" : "L CH"}
          </text>

          {/* Vivid Red Needle */}
          <line
            x1={cx}
            y1={cy}
            x2={tx}
            y2={ty}
            stroke="#ef4444"
            strokeWidth="2.2"
            strokeLinecap="round"
            style={{ transition: "all 0.15s ease-out" }}
          />

          {/* Pivot with Screw Cap */}
          <circle cx={cx} cy={cy} r="6.5" fill="#0f172a" stroke="#334155" strokeWidth="2" />
          <circle cx={cx} cy={cy} r="2.5" fill="#f8fafc" />
        </svg>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", gap: 14 }}>
      {renderMeter(leftVal, "L")}
      {renderMeter(rightVal, "R")}
    </div>
  );
}

// ============================================================================
// 2. GLOWING KT88 VACUUM TUBE WITH INTERNAL FILAMENT & ANODE CAGE
// ============================================================================
export function KT88PowerTube({
  model = "KT88",
  height = 94,
  width = 46,
  lit = true,
}: {
  model?: string;
  height?: number;
  width?: number;
  lit?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      {/* Glass Envelope */}
      <div
        style={{
          width,
          height,
          position: "relative",
          background: lit
            ? "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, rgba(255,180,60,0.2) 30%, rgba(255,100,0,0.3) 75%, rgba(0,0,0,0.6) 100%)"
            : "rgba(30,41,59,0.5)",
          borderRadius: `${width / 2}px ${width / 2}px 6px 6px`,
          border: "2px solid rgba(255,240,210,0.45)",
          boxShadow: lit
            ? "0 0 28px rgba(245,158,11,0.6), inset 0 2px 8px rgba(255,255,255,0.7)"
            : "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {/* Top Dome Reflection */}
        <div
          style={{
            position: "absolute",
            top: 2,
            left: "22%",
            right: "22%",
            height: 14,
            background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
            borderRadius: "50%",
          }}
        />

        {/* Anode Plate Screen */}
        <div
          style={{
            width: width * 0.58,
            height: height * 0.62,
            background: "linear-gradient(180deg, #334155 0%, #1e293b 50%, #0f172a 100%)",
            border: "1.5px solid #475569",
            borderRadius: 4,
            position: "relative",
            boxShadow: "inset 0 0 6px #000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Glowing Tungsten Wire Filament */}
          {lit && (
            <div
              style={{
                width: 4,
                height: "82%",
                background: "linear-gradient(180deg, #fffbeb 0%, #fde047 25%, #f59e0b 50%, #ea580c 80%, #dc2626 100%)",
                borderRadius: 2,
                boxShadow: "0 0 14px #f59e0b, 0 0 24px #ea580c, 0 0 38px #ff4500",
                animation: "tubeFlicker 3.5s infinite alternate ease-in-out",
              }}
            />
          )}
        </div>

        {/* Model Inscription on Glass */}
        <span
          style={{
            position: "absolute",
            bottom: 5,
            fontFamily: "monospace",
            fontSize: 8.5,
            color: "#fef08a",
            opacity: 0.9,
            fontWeight: "bold",
          }}
        >
          {model}
        </span>
      </div>

      {/* Chrome Base Collar */}
      <div
        style={{
          width: width * 0.88,
          height: 14,
          background: "linear-gradient(180deg, #f8fafc 0%, #cbd5e1 30%, #64748b 80%, #334155 100%)",
          borderRadius: "0 0 4px 4px",
          border: "1px solid #94a3b8",
          boxShadow: "0 4px 6px rgba(0,0,0,0.8), inset 0 1px 2px #fff",
        }}
      />
    </div>
  );
}

// ============================================================================
// 3. WIDE ILLUMINATED AMBER GLASS RADIOLA TUNING SCALE
// ============================================================================
export function RadiolaTopTuningScale() {
  return (
    <div className="radiola-scale-bezel">
      <div className="radiola-scale-glare" />

      <div className="radiola-scale-inner">
        {/* Top Frequency Numbers (kHz) */}
        <div className="scale-khz-row">
          <span className="scale-unit">kHz</span>
          <span>100</span>
          <span>200</span>
          <span>300</span>
          <span>400</span>
          <span>500</span>
          <span>600</span>
          <span>700</span>
          <span>800</span>
          <span>900</span>
          <span>1000</span>
          <span className="scale-unit">MHz</span>
        </div>

        {/* City Station Names */}
        <div className="scale-cities-row">
          <span>London</span>
          <span>Paris</span>
          <span>Lorkington</span>
          <span>New York</span>
          <span>Russow</span>
          <span className="active-station-city">Moscow</span>
          <span>Tokyo</span>
          <span>Frank</span>
          <span>Braham</span>
          <span>Gorgen</span>
        </div>

        {/* Bottom Frequency Numbers (MHz) */}
        <div className="scale-mhz-row">
          <span className="scale-unit">MHz</span>
          <span>20</span>
          <span>40</span>
          <span>60</span>
          <span className="active-freq-number">7.100</span>
          <span>80</span>
          <span>100</span>
          <span>120</span>
          <span>140</span>
          <span>260</span>
          <span>280</span>
          <span>300</span>
          <span className="scale-unit">MHz</span>
        </div>
      </div>

      {/* Suspended Vertical Gold Needle with Brass Slider */}
      <div className="radiola-needle-assembly">
        <div className="radiola-gold-needle" />
        <div className="radiola-needle-slider">Frequency Marker</div>
      </div>
    </div>
  );
}

// ============================================================================
// 4. VERTICAL BRASS 6E5S MAGIC EYE APERTURE
// ============================================================================
export function RadiolaMagicEyePill() {
  return (
    <div className="radiola-magiceye-capsule">
      <div className="radiola-magiceye-outer-bezel">
        <div className="radiola-magiceye-lens">
          <div className="radiola-magiceye-phosphor" />
        </div>
      </div>
      <span className="radiola-magiceye-label">6ESS</span>
    </div>
  );
}

// ============================================================================
// 5. RADIOLA VERTICAL GLASS ALCOVE WITH TWO STACKED GLOWING TUBES
// ============================================================================
export function RadiolaDualTubesAlcove() {
  return (
    <div className="radiola-tubes-alcove-frame">
      <div className="radiola-alcove-header">AUDIO OUTPUT</div>
      <div className="radiola-alcove-interior">
        <KT88PowerTube model="6П14П" height={72} width={36} />
        <div className="alcove-brass-divider">
          <span>ECHOLET</span>
        </div>
        <KT88PowerTube model="6Ж1П" height={72} width={36} />
      </div>
    </div>
  );
}

// ============================================================================
// 6. SOVIET CIRCULAR OPTICAL PROJECTION DIAL (DARK LENS, GLOWING 7.100.0 MHz)
// ============================================================================
export function SovietCircularProjectionDial() {
  return (
    <div className="soviet-optical-assembly">
      <div className="soviet-knurled-ring">
        <div className="soviet-glass-lens">
          {/* Illuminated reticle crosshair */}
          <div className="soviet-reticle-cross" />
          <div className="soviet-frequency-text">7.100.0</div>
          <div className="soviet-unit-text">MHz</div>
          <div className="soviet-lens-glare" />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 7. SOVIET SQUARE CAST-IRON NEEDLE METERS (НАПРЯЖЕНИЕ / СИГНАЛ)
// ============================================================================
export function SovietSquareCastMeter({
  label = "НАПРЯЖЕНИЕ",
  unit = "(В)",
  value = 220,
  min = 0,
  max = 300,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
}) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = -40 + pct * 80;
  const rad = (angle * Math.PI) / 180;
  const cx = 75;
  const cy = 76;
  const len = 54;
  const tx = cx + Math.sin(rad) * len;
  const ty = cy - Math.cos(rad) * len;

  return (
    <div className="soviet-square-meter-housing">
      {/* 4 Corner Hex Bolts */}
      <div className="hex-bolt tl" />
      <div className="hex-bolt tr" />
      <div className="hex-bolt bl" />
      <div className="hex-bolt br" />

      <div className="soviet-round-meter-face">
        <svg viewBox="0 0 150 85" style={{ width: "100%", height: "100%" }}>
          {/* Main Arc */}
          <path d="M 20 72 A 58 58 0 0 1 130 72" fill="none" stroke="#261b0c" strokeWidth="2" />

          {/* Ticks */}
          {[-40, -20, 0, 20, 40].map((deg, i) => {
            const r = (deg * Math.PI) / 180;
            const x1 = cx + Math.sin(r) * 54;
            const y1 = cy - Math.cos(r) * 54;
            const x2 = cx + Math.sin(r) * 61;
            const y2 = cy - Math.cos(r) * 61;
            const valLabel = Math.round(min + (i / 4) * (max - min));
            const lx = cx + Math.sin(r) * 45;
            const ly = cy - Math.cos(r) * 45;

            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#261b0c" strokeWidth={i === 2 ? 2.5 : 1.4} />
                <text
                  x={lx}
                  y={ly + 3}
                  fill="#261b0c"
                  fontSize="7.5"
                  fontFamily="'Fira Code', monospace"
                  fontWeight="900"
                  textAnchor="middle"
                >
                  {valLabel}
                </text>
              </g>
            );
          })}

          {/* Label */}
          <text x="75" y="38" fill="#1e180d" fontSize="8" fontFamily="'Courier New', monospace" fontWeight="900" textAnchor="middle">
            {label}
          </text>
          <text x="75" y="48" fill="#3f321d" fontSize="6.5" fontFamily="'Courier New', monospace" textAnchor="middle">
            {unit}
          </text>

          {/* Red Needle */}
          <line
            x1={cx}
            y1={cy}
            x2={tx}
            y2={ty}
            stroke="#dc2626"
            strokeWidth="2.2"
            strokeLinecap="round"
            style={{ transition: "all 0.15s ease-out" }}
          />

          {/* Pivot */}
          <circle cx={cx} cy={cy} r="5" fill="#1c1917" stroke="#44403c" strokeWidth="1.5" />
          <circle cx={cx} cy={cy} r="2" fill="#e2e8f0" />
        </svg>
      </div>
    </div>
  );
}

// ============================================================================
// 8. SOVIET ROW OF 6 CATHODE INDICATOR TUBES (ИНДИКАТОРЫ 1-6)
// ============================================================================
export function SovietCathodeIndicatorBar() {
  const digits = ["1", "4", "3", "2", "0", "5"];
  return (
    <div className="soviet-cathode-bank">
      <div className="soviet-cathode-title">ИНДИКАТОРЫ 1-6</div>
      <div className="soviet-cathode-row">
        {digits.map((d, i) => (
          <div key={i} className="mini-cathode-tube">
            <span className="cathode-glow-digit">{d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// 9. MCINTOSH BIAS WINDOW WITH 4 MINI PRE-AMP TUBES
// ============================================================================
export function McIntoshBiasWindow() {
  return (
    <div className="mcintosh-bias-frame">
      <div className="mcintosh-bias-title">BIAS: 45mA / VOLTS: 320V</div>
      <div className="mcintosh-bias-tubes">
        <KT88PowerTube model="12AX7" height={48} width={24} />
        <KT88PowerTube model="12AX7" height={48} width={24} />
        <KT88PowerTube model="12AX7" height={48} width={24} />
        <KT88PowerTube model="12AX7" height={48} width={24} />
      </div>
    </div>
  );
}

// ============================================================================
// 10. MCINTOSH GOLD BINDING POSTS
// ============================================================================
export function McIntoshGoldBindingPosts() {
  return (
    <div className="mcintosh-binding-posts-row">
      <div className="binding-post-col">
        <span className="binding-post-sub">SPEAKER OUTPUT</span>
        <div className="posts-pair">
          <div className="gold-binding-post black" />
          <div className="gold-binding-post red" />
        </div>
      </div>
      <div className="binding-post-col">
        <span className="binding-post-sub">INPUT</span>
        <div className="posts-pair">
          <div className="gold-binding-post red" />
          <div className="gold-binding-post black" />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 11. RED RUBBER INK STAMPS & WAX SEALS
// ============================================================================
export function SecretRubberStamp({ text = "СЕКРЕТНО" }: { text?: string }) {
  return (
    <div className="soviet-secret-stamp">
      [{text}]
    </div>
  );
}

export function WaxSeal({ text = "E2EE" }: { text?: string }) {
  return (
    <div className="radiola-wax-seal">
      <span>{text}</span>
    </div>
  );
}

// ============================================================================
// 12. HIGH-PRECISION ROTARY VERNIER KNOB WITH RADIAL TICKS
// ============================================================================
export function RotaryKnob({
  label,
  value = 50,
  size = 64,
  material = "brass",
}: {
  label: string;
  value?: number;
  size?: number;
  material?: "brass" | "bakelite" | "silver";
}) {
  const rotation = -135 + (value / 100) * 270;
  const isBig = size >= 50;

  return (
    <div className={`hardware-rotary-knob ${material}`}>
      {/* Outer Vernier Calibrated Ring */}
      <div
        style={{
          width: size + (isBig ? 24 : 10),
          height: size + (isBig ? 24 : 10),
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background:
            material === "brass"
              ? "radial-gradient(circle, #78350f 0%, #451a03 70%, #1f0b02 100%)"
              : material === "bakelite"
              ? "radial-gradient(circle, #292524 0%, #1c1917 70%, #0c0a09 100%)"
              : "radial-gradient(circle, #475569 0%, #1e293b 70%, #0f172a 100%)",
          border: material === "brass" ? "2px solid #b45309" : "2px solid #44403c",
          boxShadow: "0 4px 10px rgba(0,0,0,0.8), inset 0 1px 3px rgba(255,255,255,0.2)",
        }}
      >
        {/* Vernier Degree Numbers around ring */}
        {isBig && (
          <svg viewBox="0 0 90 90" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg, i) => {
              const r = (deg * Math.PI) / 180;
              const x1 = 45 + Math.sin(r) * 38;
              const y1 = 45 - Math.cos(r) * 38;
              const x2 = 45 + Math.sin(r) * 42;
              const y2 = 45 - Math.cos(r) * 42;
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={material === "brass" ? "#fde68a" : "#cbd5e1"}
                  strokeWidth="1.2"
                  strokeOpacity="0.8"
                />
              );
            })}
          </svg>
        )}

        {/* Central Rotating Knob Body */}
        <div
          className="knob-face"
          style={{
            width: size,
            height: size,
            transform: `rotate(${rotation}deg)`,
            cursor: "pointer",
            transition: "transform 0.1s ease-out",
          }}
        >
          {/* Raised Brass/Bakelite Center Cap */}
          <div
            style={{
              position: "absolute",
              inset: "22%",
              borderRadius: "50%",
              background:
                material === "brass"
                  ? "radial-gradient(circle at 35% 35%, #fef08a 0%, #d97706 50%, #78350f 100%)"
                  : material === "bakelite"
                  ? "radial-gradient(circle at 35% 35%, #57534e 0%, #292524 60%, #0c0a09 100%)"
                  : "radial-gradient(circle at 35% 35%, #f8fafc 0%, #94a3b8 60%, #334155 100%)",
              boxShadow: "0 2px 4px rgba(0,0,0,0.8), inset 0 1px 2px rgba(255,255,255,0.5)",
            }}
          />

          {/* Pointer Notch */}
          <div className="knob-indicator" />
        </div>
      </div>

      <span className="knob-label">{label}</span>
    </div>
  );
}

// ============================================================================
// 13. ANALOG METER
// ============================================================================
export function AnalogMeter({
  label,
  value = 5,
  min = 0,
  max = 10,
  unit = "дБ",
  styleType = "amber",
  width = 140,
  height = 80,
}: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  unit?: string;
  styleType?: "amber" | "blue" | "soviet";
  width?: number;
  height?: number;
}) {
  const clamped = Math.max(min, Math.min(max, value));
  const pct = (clamped - min) / (max - min);
  const angle = -40 + pct * 80;
  const rad = (angle * Math.PI) / 180;

  const cx = width / 2;
  const cy = height * 0.9;
  const len = height * 0.65;
  const tx = cx + Math.sin(rad) * len;
  const ty = cy - Math.cos(rad) * len;

  return (
    <div className={`analog-meter-box ${styleType}`} style={{ width, height }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "100%" }}>
        <path
          d={`M ${width * 0.15} ${cy - 5} A ${len} ${len} 0 0 1 ${width * 0.85} ${cy - 5}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <line x1={cx} y1={cy} x2={tx} y2={ty} stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4.5" fill="#1c1917" stroke="currentColor" strokeWidth="1" />
        <text x={cx} y={height * 0.45} fontSize="7.5" textAnchor="middle" fill="currentColor" fontWeight="bold">
          {label}
        </text>
        <text x={cx} y={height * 0.58} fontSize="6" textAnchor="middle" fill="currentColor" opacity="0.8">
          {unit}
        </text>
      </svg>
    </div>
  );
}

export function NixieCluster({ text }: { text: string }) {
  return (
    <div className="nixie-cluster-bar">
      {text.split("").map((ch, i) => (
        <span key={i} className={`nixie-char ${ch === ":" || ch === "." ? "punct" : "digit"}`}>
          {ch}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// 14. NORDIC OP-1 MINIMALIST HARDWARE COMPONENTS
// ============================================================================
export function NordicSpeakerGrille() {
  const holes = Array.from({ length: 48 });
  return (
    <div className="nordic-speaker-grille">
      {holes.map((_, i) => (
        <div key={i} className="speaker-dot" />
      ))}
    </div>
  );
}

export function NordicColorButtons({
  activeColor = "orange",
  onSelectColor,
}: {
  activeColor?: string;
  onSelectColor?: (color: string) => void;
}) {
  const colors = [
    { id: "orange", hex: "#e26945" },
    { id: "ochre", hex: "#dca038" },
    { id: "cyan", hex: "#4fb8ca" },
    { id: "white", hex: "#eceae4" },
  ];
  return (
    <div className="nordic-color-buttons-stack">
      {colors.map((c) => (
        <div
          key={c.id}
          className={`nordic-color-knob ${c.id === activeColor ? "active" : ""}`}
          style={{ backgroundColor: c.hex }}
          onClick={() => onSelectColor?.(c.id)}
        >
          {c.id === "white" && <div className="white-knob-notch" />}
        </div>
      ))}
    </div>
  );
}

export function NordicJogDial({
  angle = 45,
  onRotate,
}: {
  angle?: number;
  onRotate?: () => void;
}) {
  return (
    <div
      className="nordic-jog-assembly"
      onClick={onRotate}
      title="Jog Dial (Click to spin)"
      style={{
        width: 108,
        height: 108,
        borderRadius: "50%",
        background: "radial-gradient(circle at 45% 45%, #f8fafc 0%, #cbd5e1 55%, #94a3b8 100%)",
        border: "3px solid #64748b",
        boxShadow: "0 6px 16px rgba(0,0,0,0.25), inset 0 2px 4px #ffffff",
        position: "relative",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
        transform: `rotate(${angle}deg)`,
        transition: "transform 0.15s ease-out",
      }}
    >
      {/* Concentric CNC Grooves */}
      <div
        style={{
          position: "absolute",
          inset: 10,
          borderRadius: "50%",
          border: "1px dashed rgba(100, 116, 139, 0.4)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 22,
          borderRadius: "50%",
          border: "1px dashed rgba(100, 116, 139, 0.3)",
        }}
      />

      {/* Finger Indent Dimple */}
      <div
        style={{
          position: "absolute",
          top: 14,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "radial-gradient(circle at 40% 40%, #94a3b8 0%, #cbd5e1 60%, #f1f5f9 100%)",
          boxShadow: "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 2px #fff",
        }}
      />

      {/* Center Aluminum Cap */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "radial-gradient(circle at 45% 45%, #ffffff 0%, #e2e8f0 70%, #94a3b8 100%)",
          boxShadow: "0 2px 5px rgba(0,0,0,0.2)",
          border: "1px solid #cbd5e1",
        }}
      />
    </div>
  );
}

export function NordicRotaryEncoder({
  label,
  value = 50,
  color = "#0284c7",
  onClick,
}: {
  label: string;
  value?: number;
  color?: string;
  onClick?: () => void;
}) {
  const rotation = -135 + (Math.max(0, Math.min(100, value)) / 100) * 270;
  return (
    <div
      className="nordic-encoder-unit"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <div
        onClick={onClick}
        title={`${label}: ${value}`}
        style={{
          width: 46,
          height: 46,
          borderRadius: "50%",
          background: `radial-gradient(circle at 40% 40%, ${color} 0%, #1e293b 85%)`,
          border: "2.5px solid #0f172a",
          boxShadow: `0 3px 8px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.4)`,
          position: "relative",
          cursor: "pointer",
          transform: `rotate(${rotation}deg)`,
          transition: "transform 0.1s ease-out",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 4,
            left: "50%",
            transform: "translateX(-50%)",
            width: 3,
            height: 10,
            borderRadius: 2,
            backgroundColor: "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: 9,
          fontWeight: 700,
          color: "#475569",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function playHardwareClick(type: "soft" | "clack" | "chirp" = "soft") {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "chirp") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(1400, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
      osc.start();
      osc.stop(ctx.currentTime + 0.04);
    } else {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(type === "clack" ? 220 : 680, ctx.currentTime);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    }
  } catch {
    // AudioContext blocked before interaction
  }
}




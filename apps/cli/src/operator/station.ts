import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ensureEcholetDirs,
  getGlobalConfig,
  saveGlobalConfig,
  getProfileDir,
  getStoreKeyPath,
  getClientDbPath,
  getCardPath,
  listProfiles,
  ensureKeyPermissions,
} from "../runtime/globalPaths.js";
import { startDaemon, stopDaemon, getDaemonStatus } from "../runtime/daemon.js";
import { ask, confirm, closeReadline } from "./prompts.js";
import { openProfile } from "../runtime/profile.js";
import { openOutboundMessenger } from "../runtime/outbound.js";
import { RelayClient } from "../transport/relayClient.js";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

function resolveWebServerPath(): string {
  const candidates = [
    resolve(HERE, "../web-dist/server.js"),
    resolve(HERE, "./web-dist/server.js"),
    resolve(HERE, "../../web/dist/server.js"),
    resolve(HERE, "../../../apps/web/dist/server.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[2] ?? candidates[0] ?? "";
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

export async function handleStationCommand(args: string[]): Promise<void> {
  const sub = args[0] || "setup";
  ensureEcholetDirs();

  if (sub === "setup" || (!sub.startsWith("-") && sub === "station")) {
    console.log(`\n=== 📻 МАСТЕР НАСТРОЙКИ СТАНЦИИ ECHOLET ===\n`);
    const callsign = await ask("Введите позывной станции (Callsign)", "Echo-Operator");
    const dir = getProfileDir(callsign);

    if (existsSync(dir)) {
      if (existsSync(getClientDbPath(callsign))) {
        const overwrite = await confirm(`Станция "${callsign}" уже существует. Перезаписать ключи? (ВНИМАНИЕ: данные будут удалены)`, false);
        if (!overwrite) {
          console.log("Настройка отменена.");
          closeReadline();
          return;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }

    let relayUrl = (await ask("URL ретранслятора/релея", "https://depr.tail5a88fb.ts.net:8443")).trim();
    try {
      const u = new URL(relayUrl);
      relayUrl = u.origin;
    } catch {}
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const key = randomBytes(32);
    const storeKeyBase64 = key.toString("base64url");
    const keyPath = getStoreKeyPath(callsign);
    writeFileSync(keyPath, storeKeyBase64, { mode: 0o600 });
    ensureKeyPermissions(keyPath);

    console.log(`\n⏳ Генерация криптографических связок Double Ratchet & PreKeys...`);
    const profileConfig = {
      profile_version: 1,
      profile_id: randomUUID(),
      relay_url: relayUrl,
      database_path: "client.sqlite",
      store_key_env: "ECHOLET_STORE_KEY",
      request_timeout_ms: 10000,
      poll_batch_size: 20,
    };

    process.env.ECHOLET_STORE_KEY = storeKeyBase64;
    const profile = await openProfile({
      profileDir: dir,
      config: profileConfig,
      environment: process.env,
      initialize: true,
    });

    try {
      const card = await profile.exportContact();
      const cardPath = getCardPath(callsign);
      writeFileSync(cardPath, JSON.stringify(card, null, 2), { mode: 0o600 });
      console.log(`✅ Карточка абонента экспортирована: ${cardPath}`);
    } finally {
      await profile.close();
    }

    console.log(`⏳ Публикация пред-ключей (PreKeys) на релее...`);
    try {
      const messenger = await openOutboundMessenger({
        profileDir: dir,
        environment: process.env,
        relay: new RelayClient({ baseUrl: relayUrl, timeoutMs: 10000 }),
      });
      await messenger.publish();
      await messenger.close();
      console.log(`✅ Связки успешно опубликованы на ретрансляторе!`);
    } catch (err: any) {
      console.warn(`⚠️ Не удалось опубликовать ключи на релее прямо сейчас: ${err.message}`);
      console.warn(`(Станция опубликует их автоматически при первом подключении к сети)`);
    }

    const globalCfg = getGlobalConfig();
    globalCfg.activeProfile = callsign;
    saveGlobalConfig(globalCfg);

    console.log(`\n🎉 Станция "${callsign}" успешно создана и выбрана активной!`);
    console.log(`Запустите веб-клиент командой: echolet station start\n`);
    closeReadline();
    return;
  }

  if (sub === "start") {
    const config = getGlobalConfig();
    let targetProfile = config.activeProfile || listProfiles()[0];
    const profileIdx = args.indexOf("--profile");
    if (profileIdx !== -1 && args[profileIdx + 1]) {
      targetProfile = args[profileIdx + 1];
    }

    if (!targetProfile) {
      console.error("Ошибка: нет созданных станций. Сначала выполните: echolet station");
      process.exit(1);
    }

    let port = 3001;
    const portIdx = args.indexOf("--port");
    const portArg = portIdx !== -1 ? args[portIdx + 1] : undefined;
    if (portArg) {
      port = parseInt(portArg, 10) || 3001;
    }

    const isDaemon = args.includes("--daemon") || args.includes("-d");
    const shouldOpen = args.includes("--open") || args.includes("-o");

    const profileDir = getProfileDir(targetProfile);
    const keyPath = getStoreKeyPath(targetProfile);
    if (!existsSync(keyPath)) {
      console.error(`Ошибка: ключ хранилища ${keyPath} не найден.`);
      process.exit(1);
    }
    const storeKey = readFileSync(keyPath, "utf8").trim();

    const serverScript = resolveWebServerPath();
    if (!existsSync(serverScript)) {
      console.error(`Ошибка: веб-сервер не найден по пути ${serverScript}.`);
      console.error("Запустите сборку: pnpm --filter @echolet/web build");
      process.exit(1);
    }

    const serverArgs = [
      serverScript,
      "--port",
      port.toString(),
      "--profile",
      profileDir,
      "--label",
      targetProfile,
    ];

    const env = {
      ...process.env,
      ECHOLET_STORE_KEY: storeKey,
      ECHOLET_CLI_PATH: process.argv[1] || resolve(HERE, "../dist/cli.js"),
    };

    if (isDaemon) {
      const status = getDaemonStatus("station");
      if (status.running) {
        console.log(`⚠️ Станция уже запущена (PID: ${status.pid}). Порт: http://127.0.0.1:${port}`);
        if (shouldOpen) openBrowser(`http://127.0.0.1:${port}`);
        return;
      }
      const daemon = startDaemon("station", process.execPath, serverArgs, env);
      console.log(`\n🚀 Станция "${targetProfile}" запущена в фоновом режиме (PID: ${daemon.pid})`);
      console.log(`   Адрес интерфейса: http://127.0.0.1:${port}`);
      console.log(`   Файл журнала:     ${daemon.logPath}\n`);
      if (shouldOpen) openBrowser(`http://127.0.0.1:${port}`);
      return;
    }

    console.log(`\n🚀 Запуск станции "${targetProfile}" на http://127.0.0.1:${port}... (Ctrl+C для остановки)\n`);
    if (shouldOpen) {
      setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 800);
    }
    const child = spawn(process.execPath, serverArgs, { env, stdio: "inherit" });
    child.on("exit", (code: number | null) => {
      process.exit(code ?? 0);
    });
    return;
  }

  if (sub === "stop") {
    const res = stopDaemon("station");
    if (res.success) {
      console.log(`🛑 Станция успешно остановлена (бывший PID: ${res.pid}).`);
    } else {
      console.log(`ℹ️ Станция не запущена (${res.error}).`);
    }
    return;
  }

  if (sub === "status") {
    const status = getDaemonStatus("station");
    const config = getGlobalConfig();
    console.log(`\n📊 СТАТУС ВЕБ-СТАНЦИИ ECHOLET:`);
    console.log(`  Активный профиль: ${config.activeProfile || "не выбран"}`);
    if (status.running) {
      console.log(`  Состояние:        🟢 Работает (PID: ${status.pid})`);
      console.log(`  Лог-файл:         ${status.logPath}`);
    } else {
      console.log(`  Состояние:        ⚪ Остановлена`);
    }
    console.log("");
    return;
  }

  if (sub === "open") {
    let port = 3001;
    const portIdx = args.indexOf("--port");
    const portArg = portIdx !== -1 ? args[portIdx + 1] : undefined;
    if (portArg) {
      port = parseInt(portArg, 10) || 3001;
    }
    openBrowser(`http://127.0.0.1:${port}`);
    console.log(`Открываем интерфейс станции: http://127.0.0.1:${port}`);
    return;
  }

  console.log(`Неизвестная команда: echolet station ${sub}`);
  console.log(`Доступно: setup, start [--daemon] [--open], stop, status, open`);
}

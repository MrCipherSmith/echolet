import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { ensureGlobalDirs } from "../runtime/globalPaths";
import { startDaemonProcess, stopDaemon, getDaemonStatus, getLogPath } from "../runtime/daemon";
import { ask, askChoice } from "./prompts";
import {
  buildDockerRunArgs,
  DEFAULT_REPEATER_PORT,
  formatEnvFile,
  parseEnvFile,
  REPEATER_CONTAINER_NAME,
  REPEATER_IMAGE,
  RepeaterConfigError,
  resolveStartConfig,
  validateCallsign,
  validateEnvValue,
  validatePort,
} from "./repeaterConfig";

// Every docker call goes through execFileSync with an argv array, never a shell.
function docker(args: string[], options: Parameters<typeof execFileSync>[2] = {}) {
  return execFileSync("docker", args, options);
}

async function askValid<T>(question: string, fallback: string, validate: (value: string) => T): Promise<T> {
  for (;;) {
    const answer = await ask(question, fallback);
    try {
      return validate(answer);
    } catch (error) {
      if (!(error instanceof RepeaterConfigError)) throw error;
      console.error(`❌ ${error.message}`);
    }
  }
}

export async function handleRepeaterCommand(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  const { repeater } = ensureGlobalDirs();
  const envFile = join(repeater, "config.env");

  if (sub === "setup") {
    console.log(`\n=== 📡 НАСТРОЙКА ЛОКАЛЬНОГО РЕПИТЕРА ECHOLET ===\n`);
    const callsign = await askValid("Позывной репитера (Callsign)", "REPEATER-01", validateCallsign);
    const port = await askValid("Порт для входящих соединений", String(DEFAULT_REPEATER_PORT), validatePort);

    const mode = await askChoice(
      "Выберите режим развёртывания:",
      [
        { label: "Docker (Изолированный легковесный контейнер)", value: "docker" },
        { label: "Tailscale Mesh (Приватная зашифрованная сеть с TLS)", value: "tailscale" },
        { label: "Локальный процесс Go (для разработки)", value: "native" },
      ],
      0
    );

    let tlsCert = "";
    let tlsKey = "";
    if (mode === "tailscale") {
      const tailHost = await askValid("Доменное имя хоста в Tailscale (например, my-node.tailnet.ts.net)", "",
        (value) => validateEnvValue("хоста Tailscale", value));
      tlsCert = await askValid("Путь к cert.pem", `/etc/echolet/tls/${tailHost}.crt`,
        (value) => validateEnvValue("ECHOLET_TLS_CERT_FILE", value));
      tlsKey = await askValid("Путь к key.pem", `/etc/echolet/tls/${tailHost}.key`,
        (value) => validateEnvValue("ECHOLET_TLS_KEY_FILE", value));
    }

    const entries: Array<[string, string]> = [
      ["ECHOLET_NODE_CALLSIGN", callsign],
      ["ECHOLET_HTTP_ADDR", `0.0.0.0:${port}`],
      ["ECHOLET_DATA_DIR", join(repeater, "data")],
      ["ECHOLET_LOG_LEVEL", "info"],
      ["ECHOLET_MODE", mode],
      ["ECHOLET_PORT", String(port)],
    ];
    if (tlsCert) entries.push(["ECHOLET_TLS_CERT_FILE", tlsCert]);
    if (tlsKey) entries.push(["ECHOLET_TLS_KEY_FILE", tlsKey]);
    const envContent = formatEnvFile(entries);

    mkdirSync(join(repeater, "data"), { recursive: true, mode: 0o700 });
    writeFileSync(envFile, envContent, { mode: 0o600 });
    console.log(`\n✅ Конфигурация сохранена в: ${envFile}`);
    console.log(`Запустите узел командой: echolet repeater start\n`);
    return;
  }

  if (sub === "start") {
    const isDocker = args.includes("--docker");
    const isDaemon = args.includes("--daemon") || args.includes("-d");

    const cfg = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};

    let port: number;
    let callsign: string;
    try {
      ({ port, callsign } = resolveStartConfig(cfg));
    } catch (error) {
      if (!(error instanceof RepeaterConfigError)) throw error;
      console.error(`❌ ${error.message}`);
      console.error(`Исправьте ${envFile} или выполните: echolet repeater setup`);
      process.exitCode = 1;
      return;
    }
    const mode = isDocker ? "docker" : cfg.ECHOLET_MODE || "docker";

    if (mode === "docker") {
      console.log(`🐳 Запуск репитера "${callsign}" в Docker на порту ${port}...`);
      try {
        docker(["--version"], { stdio: "ignore" });
      } catch {
        console.error("❌ Ошибка: Docker не найден в PATH. Установите Docker или используйте нативный режим.");
        process.exit(1);
      }

      let imageExists = false;
      try {
        const out = docker(["images", "-q", REPEATER_IMAGE], { encoding: "utf8" });
        imageExists = String(out).trim().length > 0;
      } catch {}

      if (!imageExists) {
        console.log(`🔨 Образ ${REPEATER_IMAGE} не найден. Запускаю сборку...`);
        const root = join(__dirname, "../../..");
        docker(["build", "-t", REPEATER_IMAGE, "-f", "apps/relay/Dockerfile", "apps/relay"], {
          cwd: root,
          stdio: "inherit",
        });
      }

      try { docker(["rm", "-f", REPEATER_CONTAINER_NAME], { stdio: "ignore" }); } catch {}

      const dataDir = join(repeater, "data");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });

      const id = String(docker(buildDockerRunArgs({ callsign, port }, dataDir), { encoding: "utf8" })).trim();
      console.log(`✅ Контейнер репитера успешно запущен: ${id.slice(0, 12)}`);
      console.log(`📡 Адрес узла: http://127.0.0.1:${port}`);
      console.log(`Проверить статус: echolet repeater status`);
      return;
    }

    // Native Go mode
    console.log(`🚀 Запуск нативного Go-репитера на порту ${port}...`);
    const status = getDaemonStatus("repeater");
    if (status.running) {
      console.log(`⚠️ Репитер уже запущен (PID: ${status.meta?.pid})`);
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ECHOLET_HTTP_ADDR: `:${port}`,
      ECHOLET_DATA_DIR: join(repeater, "data"),
      ECHOLET_NODE_CALLSIGN: callsign,
    };

    if (isDaemon) {
      const meta = startDaemonProcess({
        name: "repeater",
        execPath: "go",
        args: ["run", "./apps/relay/cmd/relay"],
        env,
        port,
      });
      console.log(`✅ Фоновый репитер запущен (PID: ${meta.pid}) на порту ${port}.`);
      console.log(`Логи: echolet repeater logs`);
    } else {
      const child = spawn("go", ["run", "./apps/relay/cmd/relay"], {
        stdio: "inherit",
        env,
      });
      child.on("exit", (code) => {
        console.log(`Репитер остановлен с кодом: ${code}`);
      });
    }
    return;
  }

  if (sub === "stop") {
    try {
      docker(["stop", REPEATER_CONTAINER_NAME], { stdio: "ignore" });
      docker(["rm", REPEATER_CONTAINER_NAME], { stdio: "ignore" });
      console.log("🛑 Docker-контейнер echolet-relay остановлен.");
    } catch {}

    const res = stopDaemon("repeater");
    if (res.ok) console.log(res.message);
    return;
  }

  if (sub === "status") {
    console.log(`\n=== 📡 СТАТУС РЕПИТЕРА ECHOLET ===`);
    let runningDocker = false;
    try {
      const out = String(docker(["ps", "--filter", `name=${REPEATER_CONTAINER_NAME}`, "--format", "{{.Status}}"], { encoding: "utf8" })).trim();
      if (out) {
        console.log(`  🐳 Docker-контейнер: РАБОТАЕТ (${out})`);
        runningDocker = true;
      }
    } catch {}

    const daemonStatus = getDaemonStatus("repeater");
    if (daemonStatus.running && daemonStatus.meta) {
      console.log(`  🚀 Нативный процесс: РАБОТАЕТ (PID: ${daemonStatus.meta.pid}, Порт: ${daemonStatus.meta.port})`);
    } else if (!runningDocker) {
      console.log(`  ⚪ Репитер не запущен.`);
    }

    try {
      const http = await import("node:http");
      http.get("http://127.0.0.1:8081/health", (res) => {
        res.on("data", (chunk) => {
          console.log(`  🩺 Ответ /health: ${chunk.toString().trim()}`);
        });
      }).on("error", () => {});
    } catch {}
    console.log("");
    return;
  }

  if (sub === "logs") {
    try {
      docker(["logs", "--tail", "50", "-f", REPEATER_CONTAINER_NAME], { stdio: "inherit" });
    } catch {
      const logFile = getLogPath("repeater");
      if (existsSync(logFile)) {
        console.log(readFileSync(logFile, "utf8").split("\n").slice(-50).join("\n"));
      } else {
        console.log("Логи не найдены.");
      }
    }
    return;
  }

  console.log(`Неизвестная подкоманда: ${sub}. Доступно: setup, start, stop, status, logs`);
}

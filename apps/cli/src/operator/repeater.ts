import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { ensureGlobalDirs } from "../runtime/globalPaths";
import { startDaemonProcess, stopDaemon, getDaemonStatus, getLogPath } from "../runtime/daemon";
import { ask, askChoice } from "./prompts";

export async function handleRepeaterCommand(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  const { repeater } = ensureGlobalDirs();
  const envFile = join(repeater, "config.env");

  if (sub === "setup") {
    console.log(`\n=== 📡 НАСТРОЙКА ЛОКАЛЬНОГО РЕПИТЕРА ECHOLET ===\n`);
    const callsign = await ask("Позывной репитера (Callsign)", "REPEATER-01");
    const portStr = await ask("Порт для входящих соединений", "8081");
    const port = parseInt(portStr, 10) || 8081;

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
      const tailHost = await ask("Доменное имя хоста в Tailscale (например, my-node.tailnet.ts.net)");
      tlsCert = await ask("Путь к cert.pem", `/etc/echolet/tls/${tailHost}.crt`);
      tlsKey = await ask("Путь к key.pem", `/etc/echolet/tls/${tailHost}.key`);
    }

    const envContent = [
      `ECHOLET_NODE_CALLSIGN=${callsign}`,
      `ECHOLET_HTTP_ADDR=0.0.0.0:${port}`,
      `ECHOLET_DATA_DIR=${join(repeater, "data")}`,
      `ECHOLET_LOG_LEVEL=info`,
      `ECHOLET_MODE=${mode}`,
      `ECHOLET_PORT=${port}`,
      tlsCert ? `ECHOLET_TLS_CERT_FILE=${tlsCert}` : "",
      tlsKey ? `ECHOLET_TLS_KEY_FILE=${tlsKey}` : "",
    ].filter(Boolean).join("\n") + "\n";

    mkdirSync(join(repeater, "data"), { recursive: true, mode: 0o700 });
    writeFileSync(envFile, envContent, { mode: 0o600 });
    console.log(`\n✅ Конфигурация сохранена в: ${envFile}`);
    console.log(`Запустите узел командой: echolet repeater start\n`);
    return;
  }

  if (sub === "start") {
    const isDocker = args.includes("--docker");
    const isDaemon = args.includes("--daemon") || args.includes("-d");

    let cfg: Record<string, string> = {};
    if (existsSync(envFile)) {
      const raw = readFileSync(envFile, "utf8");
      for (const line of raw.split("\n")) {
        const [k, ...v] = line.split("=");
        if (k && v.length) cfg[k.trim()] = v.join("=").trim();
      }
    }

    const port = cfg.ECHOLET_PORT || "8081";
    const callsign = cfg.ECHOLET_NODE_CALLSIGN || "LOCAL-REPEATER";
    const mode = isDocker ? "docker" : cfg.ECHOLET_MODE || "docker";

    if (mode === "docker") {
      console.log(`🐳 Запуск репитера "${callsign}" в Docker на порту ${port}...`);
      try {
        execSync("docker --version", { stdio: "ignore" });
      } catch {
        console.error("❌ Ошибка: Docker не найден в PATH. Установите Docker или используйте нативный режим.");
        process.exit(1);
      }

      let imageExists = false;
      try {
        const out = execSync("docker images -q echolet-relay:latest", { encoding: "utf8" });
        imageExists = out.trim().length > 0;
      } catch {}

      if (!imageExists) {
        console.log("🔨 Образ echolet-relay:latest не найден. Запускаю сборку...");
        const root = join(__dirname, "../../..");
        execSync("docker build -t echolet-relay:latest -f apps/relay/Dockerfile apps/relay", {
          cwd: root,
          stdio: "inherit",
        });
      }

      try { execSync("docker rm -f echolet-relay", { stdio: "ignore" }); } catch {}

      const dataDir = join(repeater, "data");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });

      const cmd = `docker run -d \
        --name echolet-relay \
        --restart unless-stopped \
        --user 10001:10001 \
        -p 127.0.0.1:${port}:8443 \
        -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
        -e ECHOLET_DATA_DIR=/var/lib/echolet \
        -e ECHOLET_NODE_CALLSIGN=${callsign} \
        -v ${dataDir}:/var/lib/echolet \
        echolet-relay:latest`;

      const id = execSync(cmd, { encoding: "utf8" }).trim();
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
        port: parseInt(port, 10),
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
      execSync("docker stop echolet-relay", { stdio: "ignore" });
      execSync("docker rm echolet-relay", { stdio: "ignore" });
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
      const out = execSync("docker ps --filter name=echolet-relay --format '{{.Status}}'", { encoding: "utf8" });
      if (out.trim()) {
        console.log(`  🐳 Docker-контейнер: РАБОТАЕТ (${out.trim()})`);
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
      execSync("docker logs --tail 50 -f echolet-relay", { stdio: "inherit" });
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

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getGlobalConfig,
  saveGlobalConfig,
  listProfiles,
  getProfileDir,
} from "../runtime/globalPaths";

export async function handleProfileCommand(args: string[]): Promise<void> {
  const sub = args[0] || "list";

  if (sub === "list") {
    const config = getGlobalConfig();
    const profiles = listProfiles();
    console.log(`\n📂 ЗАРЕГИСТРИРОВАННЫЕ СТАНЦИИ ECHOLET (~/.echolet/profiles/):\n`);
    if (profiles.length === 0) {
      console.log(`  (нет созданных станций. Выполните: echolet station)\n`);
      return;
    }
    for (const name of profiles) {
      const isCurrent = name === config.activeProfile || (profiles.length === 1 && !config.activeProfile);
      const activeMark = isCurrent ? " ⭐ [АКТИВНАЯ]" : "";
      const dir = getProfileDir(name);
      const hasDb = existsSync(join(dir, "client.sqlite"));
      const status = hasDb ? "✅ Готова" : "⚠️ Не инициализирована";
      console.log(`  📻 ${name.padEnd(20)} ${status}${activeMark}`);
    }
    console.log(`\nИспользуйте: echolet profile switch <позывной>\n`);
    return;
  }

  if (sub === "switch") {
    const target = args[1];
    if (!target) {
      console.error("Ошибка: укажите позывной. Пример: echolet profile switch RadioMan");
      process.exit(1);
    }
    const profiles = listProfiles();
    if (!profiles.includes(target)) {
      console.error(`Ошибка: профиль "${target}" не найден. Список: ${profiles.join(", ")}`);
      process.exit(1);
    }
    const config = getGlobalConfig();
    config.activeProfile = target;
    saveGlobalConfig(config);
    console.log(`✅ Активной станцией по умолчанию выбрана: ${target}`);
    return;
  }

  if (sub === "export") {
    const config = getGlobalConfig();
    const target = args[1] && !args[1].startsWith("-") ? args[1] : config.activeProfile || listProfiles()[0];
    if (!target) {
      console.error("Ошибка: профили не найдены.");
      process.exit(1);
    }
    const dir = getProfileDir(target);
    const cardPath = join(dir, "identity.card.json");
    if (!existsSync(cardPath)) {
      console.error(`Карточка профиля ${target} не найдена на диске (${cardPath}).`);
      process.exit(1);
    }
    const cardContent = readFileSync(cardPath, "utf8");
    const outFlagIdx = args.indexOf("--out");
    const outArg = outFlagIdx !== -1 ? args[outFlagIdx + 1] : undefined;
    if (outArg) {
      writeFileSync(outArg, cardContent, "utf8");
      console.log(`✅ Радио-карточка станции "${target}" сохранена в: ${outArg}`);
    } else {
      console.log(`\n=== 📻 РАДИО-КАРТОЧКА СТАНЦИИ: ${target} ===`);
      console.log(cardContent);
      console.log("==================================================");
      console.log("Передайте этот JSON собеседнику (echolet contact add <файл>)");
    }
    return;
  }

  if (sub === "delete") {
    const target = args[1];
    if (!target) {
      console.error("Ошибка: укажите имя профиля для удаления.");
      process.exit(1);
    }
    const dir = getProfileDir(target);
    if (!existsSync(dir)) {
      console.error(`Профиль "${target}" не существует.`);
      process.exit(1);
    }
    const { confirm } = await import("./prompts");
    const ok = await confirm(`Вы ТОЧНО уверены, что хотите БЕЗВОЗВРАТНО удалить станцию "${target}" и всю историю?`, false);
    if (ok) {
      rmSync(dir, { recursive: true, force: true });
      const config = getGlobalConfig();
      if (config.activeProfile === target) {
        config.activeProfile = undefined;
        saveGlobalConfig(config);
      }
      console.log(`🗑️ Профиль "${target}" успешно удалён.`);
    } else {
      console.log("Удаление отменено.");
    }
    return;
  }

  console.log(`Неизвестная подкоманда: ${sub}. Доступно: list, switch, export, delete`);
}

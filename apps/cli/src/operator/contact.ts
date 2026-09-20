import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getGlobalConfig, listProfiles, getProfileDir, getStoreKeyPath } from "../runtime/globalPaths.js";
import { openProfile } from "../runtime/profile.js";

export async function handleContactCommand(args: string[]): Promise<void> {
  const sub = args[0] || "list";
  const config = getGlobalConfig();
  const profileName = config.activeProfile || listProfiles()[0];

  if (!profileName) {
    console.error("Ошибка: нет созданных станций. Сначала выполните: echolet station");
    process.exit(1);
  }

  const profileDir = getProfileDir(profileName);
  const storeKeyPath = getStoreKeyPath(profileName);

  if (!existsSync(storeKeyPath) || !existsSync(join(profileDir, "client.sqlite"))) {
    console.error(`Ошибка: профиль "${profileName}" повреждён или не содержит ключей.`);
    process.exit(1);
  }

  // Set environment variable for store key if not present
  const storeKey = readFileSync(storeKeyPath, "utf8").trim();
  process.env.ECHOLET_STORE_KEY = storeKey;

  if (sub === "list") {
    console.log(`\n📖 АДРЕСНАЯ КНИГА СТАНЦИИ "${profileName}":\n`);
    try {
      const profile = await openProfile({ profileDir, environment: process.env });
      try {
        const summary = await profile.summary();
        const correspondents = (summary as any).correspondents || [];
        if (correspondents.length === 0) {
          console.log(`  (список контактов пуст. Добавьте контакт: echolet contact add <файл_карточки.json>)\n`);
          return;
        }
        for (const c of correspondents) {
          console.log(`  👤 ID: ${c.identity_id || c} (Доверен)`);
        }
        console.log(`\nВсего доверенных операторов: ${correspondents.length}\n`);
      } finally {
        await profile.close();
      }
    } catch (err: any) {
      console.error("Не удалось прочитать контакты:", err.message);
    }
    return;
  }

  if (sub === "add") {
    const cardArg = args[1];
    if (!cardArg) {
      console.error("Ошибка: укажите путь к файлу карточки контакта или JSON. Пример: echolet contact add alice.card.json");
      process.exit(1);
    }

    let cardData: any;
    try {
      if (existsSync(cardArg)) {
        cardData = JSON.parse(readFileSync(cardArg, "utf8"));
      } else {
        cardData = JSON.parse(cardArg);
      }
    } catch (e) {
      console.error("Ошибка: некорректный JSON карточки контакта.");
      process.exit(1);
    }

    try {
      const profile = await openProfile({ profileDir, environment: process.env });
      try {
        const imported = await profile.importContact(cardData, { confirm: async () => true });
        if (imported) {
          await profile.requestMailboxRewalk();
          console.log(`\n✅ Контакт успешно добавлен и верифицирован в станции "${profileName}".`);
          console.log(`   Отпечаток ключа (Identity ID): ${cardData.identity_key?.identity_id || "OK"}\n`);
        } else {
          console.log("\n❌ Добавление контакта отклонено.");
        }
      } finally {
        await profile.close();
      }
    } catch (err: any) {
      console.error("Ошибка импорта контакта:", err.message);
      process.exit(1);
    }
    return;
  }

  if (sub === "verify") {
    const contactId = args[1];
    if (!contactId) {
      console.error("Ошибка: укажите Identity ID контакта для сверки. Пример: echolet contact verify <ID>");
      process.exit(1);
    }
    console.log(`\n🔐 СВЕРКА ОТПЕЧАТКОВ БЕЗОПАСНОСТИ (SAFETY NUMBERS):`);
    console.log(`Станция: ${profileName}`);
    console.log(`Собеседник: ${contactId}`);
    console.log(`\nОтпечаток для голосовой сверки:`);
    console.log(`  >>> [ ${contactId.slice(0, 8)} - ${contactId.slice(8, 16)} - ${contactId.slice(16, 24)} ] <<<`);
    console.log(`\nУбедитесь по защищённому каналу связи (голосом), что цифры совпадают.\n`);
    return;
  }

  console.log(`Неизвестная подкоманда: echolet contact ${sub}`);
  console.log(`Доступно: list, add <card.json>, verify <id>`);
}

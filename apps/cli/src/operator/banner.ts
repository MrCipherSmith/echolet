export function printBanner(): void {
  console.log(`
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  ┃   📻  E C H O L E T  —  S E C U R E   R A D I O         ┃
  ┃   Zero-Knowledge End-to-End Encrypted Mesh Messenger   ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
`);
}

export function printHelp(): void {
  printBanner();
  console.log(`ИСПОЛЬЗОВАНИЕ:
  echolet <команда> [опции]

ОСНОВНЫЕ КОМАНДЫ ДЛЯ ПОЛЬЗОВАТЕЛЯ:

  📻 СТАНЦИЯ (ВЕБ-КЛИЕНТ):
    echolet station                    Интерактивный мастер создания и настройки станции
    echolet station start [--daemon]   Запустить веб-интерфейс радиостанции (--open откроет браузер)
    echolet station stop               Остановить фоновый веб-клиент
    echolet station status             Проверить статус работы станции и порты
    echolet station open               Открыть веб-интерфейс в браузере

  📡 РЕПИТЕР / РЕЛЕ (СЕТЕВОЙ УЗЕЛ):
    echolet repeater setup             Мастер развёртывания (Docker, Tailscale TLS, Native)
    echolet repeater start [--docker]  Запустить узел-репитер
    echolet repeater stop              Остановить репитер
    echolet repeater status            Проверить состояние репитера и TLS
    echolet repeater logs              Показать последние логи работы узла

  👤 ПРОФИЛИ И КЛЮЧИ:
    echolet profile list               Список всех зарегистрированных станций
    echolet profile switch <callsign>  Сделать станцию активной по умолчанию
    echolet profile export [--out f]   Экспорт вашей радио-карточки (публичные ключи)
    echolet profile delete <callsign>  Удалить профиль с диска

  🤝 КОНТАКТЫ И СВЯЗЬ:
    echolet contact list               Список доверенных радиостанций
    echolet contact add <card.json>    Добавить абонента по его радио-карточке
    echolet contact verify <callsign>  Сверка Safety Numbers для защиты от MITM

  🎛️ ТЕРМИНАЛЬНАЯ РАДИОСТАНЦИЯ:
    echolet radio                      Запустить TUI-мессенджер прямо в терминале (без браузера)
    echolet doctor                     Комплексная диагностика хранилища и связи с реле

ПРИМЕРЫ:
  echolet station                    # Создать профиль с позывным в 2 клика
  echolet station start --open       # Запустить веб-интерфейс и открыть браузер
  echolet repeater start --docker    # Поднять свой репитер в изолированном Docker
`);
}

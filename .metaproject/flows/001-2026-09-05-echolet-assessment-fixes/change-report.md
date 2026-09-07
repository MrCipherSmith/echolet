# Flow 001 — отчёт об исправлениях

Дата: 2026-09-06. Статус работы: выполнен этап исправлений документов и двух ограниченных runtime-проблем; общий flow остаётся in-progress.

## Изменения

- Инициализирован Metaproject и создан управляемый flow через Keryx CLI. Служебные файлы, правила, модули, dashboard и registry созданы штатным init. Git-репозитория нет, ветка/PR/коммиты не создавались.
- Исправлены HTTP/TLS transport и точные signing contracts create/poll/ack; убраны необоснованные обещания сокращения утечки метаданных. Описано, какие identity/device/timing данные видит relay.
- В Go атомарная транзакция Badger потребляет challenge только после проверки подписи и владельца. Конкурентные повторы получают существующую ошибку CHALLENGE_EXPIRED. Регрессионные тесты до исправления давали 16 успешных потреблений одного challenge, после — одно.
- Mobile messaging по умолчанию выключен: только development build с явным публичным opt-in разрешает текущую демонстрацию. Release/unknown build всегда запрещает её. UI сообщает о прототипе и потере состояния, не о готовом защищённом мессенджере.
- STATUS_CURRENT стал единственным актуальным статусом. Остальные status entrypoints ссылаются на него; прежние тексты сохранены в status-before/. Апрельские проверки обозначены историческими.
- Проверка библиотеки и mobile feasibility перенесены в G0, до основной реализации; независимый security review — до sensitive-use пилота. Создан PILOT-29 с гипотезой, предлагаемыми метриками и пустыми evidence полями. Синхронизированы taskpack prerequisites и TRACE-25.

## Проверка

- 15 Vitest cases PASS (включая 6 новых mobile guard regression cases, сначала RED).
- Typecheck пяти workspace packages PASS.
- Независимый Go `test -race ./...` PASS.
- 34 документа: относительные файловые ссылки разрешаются, 52 JSON fences синтаксически валидны. Семантика всех схем и anchors не заявляется проверенной.
- Независимое ревью guard и atomic consume: APPROVE, без новых actionable замечаний.
- Lint: не подтверждён. Root-команда exit 0, но package scripts отсутствуют. Health auto PASS пропускает некоторые источники; это не security certificate.

Подробности: [verification-report](verification-report.md), [independent-review](independent-review.md), [challenge-race-report](challenge-race-report.md), [specs-report](specs-report.md), [planning-report](planning-report.md).

## Критический результат session spike

[Исполняемый spike](spike/libsignal.cjs) воспроизвёл обход inbound trust rejection в установленной `@privacyresearch/libsignal-protocol-typescript@0.0.16`: Promise от isTrustedIdentity не ожидается, false не предотвращает decrypt. Результат VERIFIED_WITH_SECURITY_BLOCKER означает обнаруженную проблему. Кандидат не интегрирован и в STACK/RFC обозначен недопущенным. [Crypto report](crypto-report.md).

## Осталось открытым

T9: полноценная библиотечная сессия, identity/device binding, async adapter, atomic encrypted durable session/outbox store, контактный и messaging UX. Существующая упрощённая криптография не исправлена заменой и не считается принятой. Native bridge — кандидат, не выполненная интеграция.

T10: реальные iOS/Android, relaunch, потеря связи, доставка в фоне. T11: независимая внешняя проверка безопасности. T12: интервью и пользовательский пилот с фактическим решением. Эти результаты нельзя получить из unit tests или правки документации. Людям сообщения не отправлялись, приложение не публиковалось.

AC1–AC5 подтверждаются scoped evidence; AC6 не выполнен. Flow не переведён в implemented/done.

## Routing audit

graph_used: build/find/affected/cycles (Go graph ограничен, использованы точные source reads); wiki_used: index прочитан, пока пуст; memory: accepted search, 0 результатов; ctx_used: read/rg/run с сохранёнными raw logs; raw_rg_used: no по коду Echolet. До инициализации raw rg --files использовался только для поиска установленного skill в пакете Keryx, вне проекта.

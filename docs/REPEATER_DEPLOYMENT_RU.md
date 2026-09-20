# 📡 Руководство по развёртыванию Репитера Echolet: Docker и Tailscale Mesh

В данном руководстве описано, как безопасно развернуть собственный узел-репитер Echolet (Go-сервер очереди сообщений и PreKey связок) для личного использования или для закрытой группы абонентов.

---

## Вариант 1: Развёртывание через Docker (Локальная сеть / Тестирование)

Этот вариант изолирует процесс репитера внутри легковесного контейнера Alpine Linux от системного пользователя (`UID 10001`), гарантируя безопасность хостовой системы.

### Шаг 1: Сборка или подготовка образа
В каталоге проекта выполните сборку образа:
```bash
docker build -t echolet-relay:latest -f apps/relay/Dockerfile apps/relay
```

### Шаг 2: Запуск контейнера
Создайте локальную папку для данных и запустите контейнер:
```bash
# Создаем каталог данных
mkdir -p ~/.echolet/repeater/data
chmod 700 ~/.echolet/repeater/data

# Запускаем контейнер (привязка только к локальному интерфейсу 127.0.0.1)
docker run -d \
  --name echolet-relay \
  --restart unless-stopped \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8081:8443 \
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
  -e ECHOLET_DATA_DIR=/var/lib/echolet \
  -e ECHOLET_NODE_CALLSIGN=MY-LOCAL-REPEATER \
  -v ~/.echolet/repeater/data:/var/lib/echolet \
  echolet-relay:latest
```

### Шаг 3: Проверка статуса
```bash
curl http://127.0.0.1:8081/health
# Ответ: {"status":"ok","callsign":"MY-LOCAL-REPEATER"}
```

---

## Вариант 2: Развёртывание через Tailscale Mesh (Рекомендовано для интернета)

**Tailscale** позволяет вашим устройствам и устройствам ваших друзей связываться с репитером через зашифрованный туннель WireGuard **без открытия входящих портов наружу и без публичного «белого» IP-адреса**.

### Шаг 1: Установка Tailscale на сервере или домашнем компьютере
```bash
# Установка Tailscale (Linux)
curl -fsSL https://tailscale.com/install.sh | sh

# Авторизация и включение MagicDNS
sudo tailscale up
```

### Шаг 2: Включение доверенного HTTPS (Let's Encrypt)
1. В панели управления [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) включите переключатель **«HTTPS Certificates»**.
2. Узнайте полное доменное имя вашего узла:
   ```bash
   tailscale status
   # Например: my-server.tail5a88fb.ts.net
   ```
3. Выпустите официальный SSL-сертификат:
   ```bash
   sudo mkdir -p /etc/echolet/tls
   sudo tailscale cert \
     --cert-file /etc/echolet/tls/cert.pem \
     --key-file /etc/echolet/tls/key.pem \
     my-server.tail5a88fb.ts.net
   ```

### Шаг 3: Запуск Go-репитера с поддержкой TLS
Репитер Echolet нативно умеет отслеживать продление сертификатов `tailscale cert` каждые 60 секунд без перезапуска:
```bash
export ECHOLET_HTTP_ADDR=":8443"
export ECHOLET_TLS_CERT_FILE="/etc/echolet/tls/cert.pem"
export ECHOLET_TLS_KEY_FILE="/etc/echolet/tls/key.pem"
export ECHOLET_DATA_DIR="$HOME/.echolet/repeater/data"
export ECHOLET_NODE_CALLSIGN="TAILNET-REPEATER"

# Запуск
go run ./apps/relay/cmd/relay
```

---

## Вариант 3: Комбинация Docker + Tailscale (Золотой стандарт)

Совмещает контейнерную песочницу (Docker) и сетевую невидимость (Tailscale). В репозитории уже готов production-файл [`deploy/relay/docker-compose.yml`](../deploy/relay/docker-compose.yml).

### Шаг 1: Настройка окружения
Создайте файл `repeater.env`:
```env
ECHOLET_IMAGE=echolet-relay:latest
ECHOLET_BIND_ADDR=100.x.y.z       # Ваш Tailscale IP (узнать: tailscale ip -4)
ECHOLET_PORT=8443
ECHOLET_HOST_DATA_DIR=/var/lib/echolet
ECHOLET_HOST_TLS_DIR=/etc/echolet/tls
ECHOLET_NODE_CALLSIGN=SECURE-REPEATER
ECHOLET_LOG_LEVEL=info
```

### Шаг 2: Запуск через Docker Compose
```bash
docker compose --env-file repeater.env -f deploy/relay/docker-compose.yml up -d
```

### Шаг 3: Предоставление доступа друзьям (Node Sharing)
Чтобы друзья могли использовать ваш репитер:
1. Зайдите в панель управления Tailscale на телефоне или в браузере.
2. Найдите машину с репитером, нажмите меню `...` ➔ **Share...**.
3. Скопируйте ссылку и отправьте её собеседнику (или введите его Tailscale-аккаунт).
4. У собеседника в Echolet URL репитера будет:
   `https://my-server.tail5a88fb.ts.net:8443`
5. **Все остальные порты и ваши домашние файлы для него полностью закрыты.**

# Bio-eSign API — Panduan Penggunaan Backend

> Dokumentasi lengkap penggunaan API Bio-eSign dari awal setup hingga mencatat kehadiran (attendance).

## Daftar Isi

1. [Prasyarat](#1-prasyarat)
2. [Setup & Menjalankan Server](#2-setup--menjalankan-server)
3. [Autentikasi (Login)](#3-autentikasi-login)
4. [Menyiapkan Data Master](#4-menyiapkan-data-master)
5. [Registrasi Fingerprint via MQTT](#5-registrasi-fingerprint-via-mqtt)
6. [Alur Attendance (Kehadiran)](#6-alur-attendance-kehadiran)
7. [Manajemen Device](#7-manajemen-device)
8. [Manajemen Schedule](#8-manajemen-schedule)
9. [Referensi MQTT Topics](#9-referensi-mqtt-topics)

---

## 1. Prasyarat

| Komponen                    | Keterangan                                                              |
| --------------------------- | ----------------------------------------------------------------------- |
| **Bun**                     | Runtime & package manager ([bun.sh](https://bun.sh/))                   |
| **Podman + podman-compose** | Container runtime (⚠️ BUKAN Docker)                                     |
| **MQTT Client**             | Untuk testing: [MQTTX](https://mqttx.app/) atau `mosquitto_pub`         |
| **HTTP Client**             | Untuk testing: [Bruno](https://www.usebruno.com/), Postman, atau `curl` |

### Environment Variables

Buat file `.env.local` di root project:

```env
DATABASE_URL="postgresql://user:password@127.0.0.1:5432/bioesign_db"
JWT_SECRET="ganti-dengan-secret-yang-kuat"
BIOMETRIC_ENCRYPTION_KEY="exactly-32-characters-key-here!!"
MQTT_BROKER_URL="mqtt://127.0.0.1:1883"
MQTT_DEBUG="false" # Opsional: ubah ke "true" untuk log debug listener MQTT
REDIS_URL="redis://127.0.0.1:6379"
```

Buat juga file `.env` (untuk Prisma CLI):

```env
DATABASE_URL="postgresql://user:password@127.0.0.1:5432/bioesign_db"
```

> ⚠️ **Penting:** Gunakan `127.0.0.1` bukan `localhost`. Podman di Windows me-resolve `localhost` ke IPv6 (`::1`) yang tidak didukung container.

---

## 2. Setup & Menjalankan Server

```bash
# 1. Install dependencies
bun install

# 2. Jalankan PostgreSQL, Mosquitto, dan Redis
podman-compose up -d

# 3. Push schema ke database
bunx prisma db push

# 4. Generate Prisma Client
bunx prisma generate

# 5. Jalankan dev server
bun run dev
```

Server akan berjalan di `http://localhost:3000`. Output yang diharapkan:

```
🦊 Bio-eSign is running at localhost:3000
[MQTT] Connected to broker: mqtt://127.0.0.1:1883
[MQTT] Subscribed to: bioesign/+/attendance, bioesign/+/ping, bioesign/+/template/chunk
```

Jika ingin melihat proses subscribe dan message listener secara detail untuk debug, aktifkan:

```env
MQTT_DEBUG="true"
```

Contoh tambahan log saat mode debug aktif:

```text
[MQTT][DEBUG] Starting MQTT subscriber { broker_url: "mqtt://127.0.0.1:1883", client_id: "bioesign-server-...", topics: [...] }
[MQTT][DEBUG] MQTT message received { topic: "bioesign/ESP32_LAB_01/ping", device_id: "ESP32_LAB_01", payload_bytes: 86, qos: 1, retain: false, dup: false }
[MQTT][DEBUG] Dispatching MQTT message { topic: "bioesign/ESP32_LAB_01/ping", route: "ping", ... }
```

> Debug log hanya mencetak metadata aman. Untuk topic `template/chunk`, isi `data` fingerprint tidak pernah dicetak ke log.

### Verifikasi

```bash
curl http://localhost:3000/
```

Response:

```json
{
  "message": "Bio-eSign University Attendance API",
  "status": "online",
  "version": "1.0.0"
}
```

---

## 3. Autentikasi (Login)

Semua endpoint `/api/*` (kecuali login) membutuhkan JWT token.

### `POST /api/auth/login`

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9..."
}
```

> Simpan token ini. Semua request selanjutnya menggunakan header:
>
> ```
> Authorization: Bearer <token>
> ```

---

## 4. Menyiapkan Data Master

Sebelum attendance bisa berjalan, data master harus diisi ke database. Saat ini dilakukan langsung via Prisma/SQL karena CRUD API belum tersedia.

### 4.1 Buat Department

```sql
INSERT INTO departments (id, code, name)
VALUES (gen_random_uuid(), 'FTI', 'Fakultas Teknologi Informasi');
```

### 4.2 Buat Student

```sql
INSERT INTO students (id, nim, name, email, department_id)
VALUES (
  gen_random_uuid(),
  '2024001',
  'Ahmad Rizki',
  'ahmad@univ.ac.id',
  '<department_id>'
);
```

### 4.3 Daftarkan Device

Device juga bisa didaftarkan otomatis saat ESP32 pertama kali mengirim `ping` via MQTT (auto-upsert). Atau manual:

```sql
INSERT INTO devices (id, device_id, location_name, status)
VALUES (gen_random_uuid(), 'ESP32_LAB_01', 'Gedung A, Ruang 302', 'OFFLINE');
```

### 4.4 Buat Course & Lecturer

```sql
-- Lecturer
INSERT INTO lecturers (id, nidn, name, email, department_id)
VALUES (gen_random_uuid(), '0001', 'Dr. Budi', 'budi@univ.ac.id', '<department_id>');

-- Course
INSERT INTO courses (id, code, name, credits)
VALUES (gen_random_uuid(), 'IF101', 'Pemrograman Dasar', 3);
```

### 4.5 Buat Schedule

```sql
INSERT INTO schedules (id, course_id, lecturer_id, device_id, day_of_week, start_time, end_time, room_name)
VALUES (
  gen_random_uuid(),
  '<course_id>',
  '<lecturer_id>',
  '<device_id>',
  1,  -- Senin (0=Minggu)
  '2026-01-01 08:00:00',
  '2026-01-01 10:00:00',
  'Lab Komputer A'
);
```

> 💡 **Tip:** Gunakan `bunx prisma studio` untuk GUI database browser.

---

## 5. Registrasi Fingerprint via MQTT

Fingerprint template dikirim oleh ESP32 dalam bentuk chunk (potongan) melalui MQTT. Server merakit ulang chunk, mengenkripsi dengan AES-256-GCM, lalu menyimpan ke database.

### Alur:

```
ESP32 ──► MQTT (bioesign/{deviceId}/template/chunk) ──► Server reassembles ──► AES-256-GCM encrypt ──► DB
```

### Format Payload (per chunk):

Publish ke topic `bioesign/ESP32_LAB_01/template/chunk`:

```json
{
  "device_id": "ESP32_LAB_01",
  "student_id": "<student_uuid>",
  "slot": 1,
  "chunk_index": 0,
  "total_chunks": 3,
  "data": "base64encodedchunk1..."
}
```

Kirim semua chunk secara berurutan (0, 1, 2...). Server akan:

1. Buffer setiap chunk (timeout 60 detik).
2. Setelah semua chunk diterima → gabungkan.
3. Enkripsi template lengkap menggunakan AES-256-GCM.
4. Simpan ke tabel `student_fingerprints` (encrypted + IV + auth tag).

### Testing dengan MQTTX / mosquitto_pub

```bash
# Chunk 1 of 1 (template pendek untuk testing)
mosquitto_pub -h 127.0.0.1 -t "bioesign/ESP32_LAB_01/template/chunk" -m '{
  "device_id": "ESP32_LAB_01",
  "student_id": "<student_uuid>",
  "slot": 1,
  "chunk_index": 0,
  "total_chunks": 1,
  "data": "SGVsbG9Xb3JsZEJhc2U2NA=="
}'
```

Log server:

```
[MQTT] Template stored: student=<student_uuid> slot=1 (1 chunks)
[MQTT][DEBUG] Template chunk payload accepted { device_id: "ESP32_LAB_01", student_id: "<student_uuid>", slot: 1, chunk_index: 0, total_chunks: 1, data_length: 24 }
```

---

## 6. Alur Attendance (Kehadiran)

Ada **2 cara** attendance tercatat dalam sistem:

### 6.1 Via MQTT (dari ESP32 — Cara Utama)

Ini adalah alur utama di production. ESP32 mengirim event kehadiran melalui MQTT setelah fingerprint match.

**Topic:** `bioesign/{deviceId}/attendance`

**Payload:**

```json
{
  "device_id": "ESP32_LAB_01",
  "fingerprint_id": 1,
  "action": "check_in",
  "match_score": 95,
  "timestamp": "2026-03-08T08:00:00Z"
}
```

**Proses di Server:**

1. Lookup `student_fingerprints` berdasarkan `fingerprint_id` (fingerprint ID yang tersimpan di sensor ESP32).
2. Cek Redis untuk `active_schedule` pada device tersebut.
3. Buat record `attendance_events` dengan relasi ke student, device, dan schedule.
4. Simpan `raw_payload` sebagai JSONB untuk audit trail.

**Testing:**

```bash
mosquitto_pub -h 127.0.0.1 -t "bioesign/ESP32_LAB_01/attendance" -m '{
  "device_id": "ESP32_LAB_01",
  "fingerprint_id": 1,
  "action": "check_in",
  "match_score": 95
}'
```

Log server:

```
[MQTT] Attendance recorded: CHECK_IN by student <student_id> on ESP32_LAB_01
```

### 6.2 Via HTTP API (Manual / Dashboard)

Untuk pencatatan manual oleh admin melalui dashboard.

#### `POST /api/attendance/record`

```bash
curl -X POST http://localhost:3000/api/attendance/record \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "studentId": "<student_uuid>",
    "deviceId": "ESP32_LAB_01",
    "action": "CHECK_IN",
    "matchScore": 100
  }'
```

Response:

```json
{
  "id": "1",
  "studentId": "<student_uuid>",
  "deviceId": "ESP32_LAB_01",
  "action": "CHECK_IN",
  "matchScore": 100,
  "eventTime": "2026-03-08T08:00:00.000Z"
}
```

#### `GET /api/attendance/history`

Mengambil 10 record attendance terbaru beserta data student dan device.

```bash
curl http://localhost:3000/api/attendance/history \
  -H "Authorization: Bearer <token>"
```

Response:

```json
[
  {
    "id": "1",
    "studentId": "<student_uuid>",
    "deviceId": "ESP32_LAB_01",
    "action": "CHECK_IN",
    "matchScore": 95,
    "eventTime": "2026-03-08T08:00:00.000Z",
    "student": { "id": "...", "nim": "2024001", "name": "Ahmad Rizki" },
    "device": {
      "id": "...",
      "deviceId": "ESP32_LAB_01",
      "locationName": "Gedung A, Ruang 302"
    }
  }
]
```

---

## 7. Manajemen Device

### `GET /api/devices/`

List semua device yang terdaftar:

```bash
curl http://localhost:3000/api/devices/ \
  -H "Authorization: Bearer <token>"
```

### `GET /api/devices/online`

Cek device yang sedang online (berdasarkan cache Redis dari MQTT ping):

```bash
curl http://localhost:3000/api/devices/online \
  -H "Authorization: Bearer <token>"
```

Response:

```json
{
  "online": ["ESP32_LAB_01", "ESP32_LAB_02"],
  "count": 2
}
```

### Device Auto-Register via MQTT Ping

ESP32 yang mengirim heartbeat akan otomatis terdaftar di database:

```bash
mosquitto_pub -h 127.0.0.1 -t "bioesign/ESP32_LAB_01/ping" -m '{
  "device_id": "ESP32_LAB_01",
  "firmware_version": "1.2.0",
  "uptime_seconds": 3600
}'
```

Jika `MQTT_DEBUG="true"`, Anda juga akan melihat log seperti:

```text
[MQTT][DEBUG] MQTT message received { topic: "bioesign/ESP32_LAB_01/ping", device_id: "ESP32_LAB_01", payload_bytes: 86, qos: 1, retain: false, dup: false }
[MQTT][DEBUG] Ping payload accepted { device_id: "ESP32_LAB_01", firmware_version: "1.2.0", uptime_seconds: 3600 }
[MQTT][DEBUG] Ping handler completed { device_id: "ESP32_LAB_01", firmware_version: "1.2.0", uptime_seconds: 3600 }
```

---

## 8. Manajemen Schedule

### `POST /api/schedules/activate`

Aktifkan jadwal pada device tertentu. Data di-cache ke Redis selama 4 jam agar setiap attendance dari device tersebut otomatis terhubung ke schedule.

```bash
curl -X POST http://localhost:3000/api/schedules/activate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "deviceId": "ESP32_LAB_01",
    "scheduleId": "<schedule_uuid>"
  }'
```

Response:

```json
{
  "message": "Schedule activated",
  "deviceId": "ESP32_LAB_01",
  "scheduleId": "<schedule_uuid>"
}
```

> Setelah diaktifkan, setiap MQTT attendance yang masuk dari `ESP32_LAB_01` akan otomatis di-link ke schedule ini selama 4 jam.

---

## 9. Referensi MQTT Topics

| Topic                                | Arah           | QoS | Deskripsi                        |
| ------------------------------------ | -------------- | --- | -------------------------------- |
| `bioesign/{deviceId}/attendance`     | ESP32 → Server | 1   | Event check-in / check-out       |
| `bioesign/{deviceId}/ping`           | ESP32 → Server | 1   | Device heartbeat (auto-register) |
| `bioesign/{deviceId}/template/chunk` | ESP32 → Server | 1   | Chunk template fingerprint       |

---

## Alur Lengkap (End-to-End)

```
┌─────────────────────────────────────────────────────────────┐
│                    SETUP (Sekali)                            │
├─────────────────────────────────────────────────────────────┤
│ 1. podman-compose up -d                                     │
│ 2. bunx prisma db push                                      │
│ 3. bun run dev                                              │
│ 4. Insert data master (department, student, device, course)  │
│ 5. Register fingerprint via MQTT (template/chunk)            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 OPERASIONAL (Harian)                         │
├─────────────────────────────────────────────────────────────┤
│ 1. POST /api/auth/login → dapat token                       │
│ 2. POST /api/schedules/activate → aktifkan jadwal           │
│ 3. ESP32 mengirim ping (auto-register, status ONLINE)       │
│ 4. Mahasiswa tapping → ESP32 publish attendance via MQTT    │
│ 5. Server: lookup fingerprint → cek schedule → simpan       │
│ 6. GET /api/attendance/history → lihat data kehadiran       │
└─────────────────────────────────────────────────────────────┘
```

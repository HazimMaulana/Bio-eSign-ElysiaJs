# MQTT Topics

Dokumen ini mengikuti struktur topic yang dipakai backend dan firmware saat ini.
Default prefix adalah `presence`, atau nilai dari `MQTT_TOPIC_PREFIX` di backend.

## Kenapa Topic Tidak Muncul di MQTT Explorer

MQTT broker tidak menyimpan daftar topic seperti folder permanen. Topic baru terlihat di MQTT Explorer jika:

- client MQTT Explorer sedang subscribe saat message dikirim, atau
- message dipublish dengan retained flag.

Topic provisioning `presence/provisioning/discover` dipublish oleh ESP32 saat device boot/online, dan publish ini tidak retained. Karena itu topic biasanya tidak terlihat jika MQTT Explorer dibuka setelah event discovery lewat.

Untuk melihatnya:

1. Buka MQTT Explorer dan connect ke broker.
2. Subscribe ke wildcard `presence/#`.
3. Reboot ESP32 atau paksa device publish discovery ulang.
4. Cari message di `presence/provisioning/discover`.

## Provisioning Discovery

Topic:

```text
presence/provisioning/discover
```

Direction:

```text
ESP32 -> Broker -> Backend
```

Fungsi:

Device mengumumkan diri ke backend saat pertama online. Backend menerima message ini, melakukan upsert device, menandai device online, lalu mengirim assignment/config ke topic device jika device sudah terdaftar atau terhubung ke class.

Payload contoh:

```json
{
  "device_id": "EPS-32 S3-ABCDEF123456",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "firmware_version": "1.0.0",
  "status": "waiting_assignment",
  "ip": "192.168.1.20",
  "config_url": "http://192.168.1.20",
  "ts_ms": 123456
}
```

Backend subscribe:

```text
presence/provisioning/discover
```

Firmware publish:

```cpp
AppConfig::TOPIC_PROVISIONING_DISCOVER
```

## Device Topics

Device-specific topics memakai pola:

```text
presence/devices/{deviceId}/{suffix}
```

Common topics:

```text
presence/devices/{deviceId}/config
presence/devices/{deviceId}/command
presence/devices/{deviceId}/catalog
presence/devices/{deviceId}/attendance
presence/devices/{deviceId}/status
presence/devices/{deviceId}/template/request
presence/devices/{deviceId}/template/manifest
presence/devices/{deviceId}/template/chunk
presence/devices/{deviceId}/template/chunk/#
presence/devices/{deviceId}/template/ack
```

Server acknowledgement topic:

```text
presence/server/{deviceId}/attendance/ack
```

## Registration Topics

Registration metadata:

```text
presence/mahasiswa/registrasi
```

Registration binary template:

```text
presence/mahasiswa/registrasi/template/{deviceId}/{nim}/{slot}/{fingerId}
```

## Academic Metadata

Faculty, department, and class are not part of the main MQTT topic hierarchy.
They are sent as payload metadata, for example:

```json
{
  "device_id": "EPS-32 S3-ABCDEF123456",
  "class_code": "TI-1A",
  "class_name": "Teknik Informatika 1A",
  "department_code": "TI"
}
```

This keeps MQTT routing stable per physical device while academic mapping stays in the database.


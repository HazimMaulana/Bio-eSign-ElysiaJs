# Bio-eSign REST API Endpoints

Base URL default:

```txt
http://localhost:3000
```

## Authentication

Endpoint login tidak membutuhkan token.

```txt
GET    /                         Health/API info
POST   /api/auth/sessions         Login dan mendapatkan JWT token
```

Body login:

```json
{
  "username": "admin",
  "password": "password"
}
```

Semua endpoint `/api/*` selain `/api/auth/sessions` wajib menggunakan header:

```txt
Authorization: Bearer <token>
```

## Faculties

```txt
GET    /api/faculties
POST   /api/faculties
GET    /api/faculties/:code
PUT    /api/faculties/:code
DELETE /api/faculties/:code
```

Body `POST /api/faculties`:

```json
{
  "code": "FT",
  "name": "Fakultas Teknik"
}
```

Body `PUT /api/faculties/:code`:

```json
{
  "code": "FT",
  "name": "Fakultas Teknik"
}
```

## Departments

```txt
GET    /api/departments
POST   /api/departments
GET    /api/departments/:code
PUT    /api/departments/:code
DELETE /api/departments/:code
```

Body `POST /api/departments`:

```json
{
  "code": "TI",
  "name": "Teknik Informatika",
  "facultyCode": "FT"
}
```

Body `PUT /api/departments/:code`:

```json
{
  "code": "TI",
  "name": "Teknik Informatika",
  "facultyCode": "FT"
}
```

Field alternatif yang juga diterima: `faculty_code`.

## Students

```txt
GET    /api/students
POST   /api/students
GET    /api/students/:nim
PUT    /api/students/:nim
DELETE /api/students/:nim
GET    /api/students/:nim/fingerprints/:slot/template
PUT    /api/students/:nim/fingerprints/:slot/template
```

Body `POST /api/students`:

```json
{
  "nim": "2024001",
  "name": "Budi Santoso",
  "email": "budi@example.com",
  "isActive": true,
  "departmentCode": "TI"
}
```

Body `PUT /api/students/:nim`:

```json
{
  "nim": "2024001",
  "name": "Budi Santoso",
  "email": "budi@example.com",
  "isActive": true,
  "departmentCode": "TI"
}
```

Field alternatif yang juga diterima: `department_code`.

`GET /api/students/:nim/fingerprints/:slot/template` mengembalikan binary fingerprint template dengan `Content-Type: application/octet-stream`.

`PUT /api/students/:nim/fingerprints/:slot/template` menggunakan `multipart/form-data`.

Form data:

```txt
template       File, wajib
name           Optional
nama           Optional
fingerprintId  Optional
fingerprint_id Optional
finger_id      Optional
deviceId       Optional
device_id      Optional
classCode      Optional
class_code     Optional
```

## Lecturers

```txt
GET    /api/lecturers
POST   /api/lecturers
GET    /api/lecturers/:nidn
PUT    /api/lecturers/:nidn
DELETE /api/lecturers/:nidn
```

Body `POST /api/lecturers`:

```json
{
  "nidn": "1234567890",
  "name": "Dr. Andi",
  "email": "andi@example.com",
  "departmentCode": "TI"
}
```

Body `PUT /api/lecturers/:nidn`:

```json
{
  "nidn": "1234567890",
  "name": "Dr. Andi",
  "email": "andi@example.com",
  "departmentCode": "TI"
}
```

Field alternatif yang juga diterima: `department_code`.

## Courses

```txt
GET    /api/courses
POST   /api/courses
GET    /api/courses/:code
PUT    /api/courses/:code
DELETE /api/courses/:code

GET    /api/courses/:code/enrollments
POST   /api/courses/:code/enrollments
PUT    /api/courses/:code/enrollments
DELETE /api/courses/:code/enrollments/:nim

POST   /api/courses/:code/activations
```

Body `POST /api/courses`:

```json
{
  "code": "IF101",
  "name": "Pemrograman Dasar",
  "departmentCode": "TI",
  "classCode": "TI-1A",
  "studentNims": ["2024001", "2024002"]
}
```

Body `PUT /api/courses/:code`:

```json
{
  "code": "IF101",
  "name": "Pemrograman Dasar",
  "departmentCode": "TI",
  "classCode": "TI-1A",
  "studentNims": ["2024001", "2024002"]
}
```

Body `POST /api/courses/:code/enrollments`:

```json
{
  "studentNims": ["2024001", "2024002"]
}
```

Body `PUT /api/courses/:code/enrollments`:

```json
{
  "studentNims": ["2024001", "2024002"]
}
```

Field alternatif yang juga diterima:

```txt
department_code
class_code
student_nims
nims
nim
```

## Users

```txt
GET    /api/users
POST   /api/users
GET    /api/users/:id
PUT    /api/users/:id
DELETE /api/users/:id
```

Body `POST /api/users`:

```json
{
  "username": "admin",
  "password": "password",
  "email": "admin@example.com",
  "role": "SUPERADMIN",
  "isActive": true
}
```

Body `PUT /api/users/:id`:

```json
{
  "username": "admin",
  "password": "new-password",
  "email": "admin@example.com",
  "role": "SUPERADMIN",
  "isActive": true
}
```

Role yang diterima:

```txt
SUPERADMIN
FACULTY_ADMIN
LECTURER
STUDENT
```

## Schedules

```txt
GET    /api/schedules
POST   /api/schedules
GET    /api/schedules/:id
PUT    /api/schedules/:id
DELETE /api/schedules/:id
POST   /api/schedules/:id/activations
```

Body `POST /api/schedules`:

```json
{
  "courseCode": "IF101",
  "lecturerNidn": "1234567890",
  "deviceCode": "ESP32-001",
  "dayOfWeek": 1,
  "startTime": "2026-05-11T08:00:00.000Z",
  "endTime": "2026-05-11T10:00:00.000Z",
  "roomName": "Lab 1"
}
```

Body `PUT /api/schedules/:id`:

```json
{
  "courseCode": "IF101",
  "lecturerNidn": "1234567890",
  "deviceCode": "ESP32-001",
  "dayOfWeek": 1,
  "startTime": "2026-05-11T08:00:00.000Z",
  "endTime": "2026-05-11T10:00:00.000Z",
  "roomName": "Lab 1"
}
```

Body `POST /api/schedules/:id/activations`:

```json
{
  "deviceCode": "ESP32-001"
}
```

Field alternatif yang juga diterima:

```txt
course_code
lecturer_nidn
device_code
```

`dayOfWeek` menggunakan angka `0` sampai `6`.

## Devices

```txt
GET    /api/devices
GET    /api/devices?online=true
POST   /api/devices
GET    /api/devices/:deviceCode
PUT    /api/devices/:deviceCode
DELETE /api/devices/:deviceCode
POST   /api/devices/:deviceCode/commands
```

Body `POST /api/devices`:

```json
{
  "deviceCode": "ESP32-001",
  "status": "OFFLINE",
  "firmwareVersion": "1.0.0"
}
```

Body `PUT /api/devices/:deviceCode`:

```json
{
  "deviceCode": "ESP32-001",
  "status": "ONLINE",
  "firmwareVersion": "1.0.1"
}
```

Body `POST /api/devices/:deviceCode/commands`:

```json
{
  "type": "STANDBY"
}
```

Field alternatif yang juga diterima:

```txt
deviceId
device_id
device_code
firmware_version
```

Status yang diterima:

```txt
ONLINE
OFFLINE
MAINTENANCE
ERROR
```

## Classes

```txt
GET    /api/classes
POST   /api/classes
GET    /api/classes/:code
PUT    /api/classes/:code
DELETE /api/classes/:code
POST   /api/classes/:code/device-synchronizations
```

Body `POST /api/classes`:

```json
{
  "code": "TI-1A",
  "name": "Teknik Informatika 1A",
  "departmentCode": "TI",
  "deviceCode": "ESP32-001"
}
```

Body `PUT /api/classes/:code`:

```json
{
  "code": "TI-1A",
  "name": "Teknik Informatika 1A",
  "departmentCode": "TI",
  "deviceCode": "ESP32-001"
}
```

Body `POST /api/classes/:code/device-synchronizations`:

```json
{
  "deviceCode": "ESP32-001",
  "chunkSize": 128
}
```

Field alternatif yang juga diterima:

```txt
department_code
device_code
```

`chunkSize` minimal `64`.

## Fingerprint Registrations

```txt
POST   /api/fingerprint-registrations
```

Body:

```json
{
  "deviceId": "ESP32-001",
  "nim": "2024001",
  "name": "Budi Santoso",
  "slot": 1,
  "classCode": "TI-1A"
}
```

Field alternatif yang juga diterima:

```txt
nama
class_code
```

`slot` optional, nilai `1` sampai `3`.

## Attendance Events

```txt
GET    /api/attendance-events
GET    /api/attendance-events?limit=10
POST   /api/attendance-events
```

Body `POST /api/attendance-events`:

```json
{
  "studentId": "student-db-id",
  "deviceId": "device-db-id",
  "scheduleId": "schedule-db-id",
  "action": "CHECK_IN",
  "matchScore": 95.5
}
```

Action yang diterima:

```txt
CHECK_IN
CHECK_OUT
```

`limit` pada `GET /api/attendance-events` minimal `1`, maksimal `1000`, default `10`.

## Summary

Total endpoint saat file ini dibuat:

```txt
60 endpoint
```

Termasuk:

```txt
GET  /
POST /api/auth/sessions
```

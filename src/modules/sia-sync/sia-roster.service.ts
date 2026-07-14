import { prisma } from "../../lib/prisma";

const HARI_KULIAH_LIST = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"] as const;

interface SiaKelasPayload {
  id: number;
  id_mk: string;
  kode_mk: string;
  nama_mk: string;
  tahun_akademik: number;
  hari_kuliah: string;
  jam_kuliah: string;
  ruang_kelas: string;
  nama_kelas: string;
  kapasitas_kelas: number;
  nama_dosen: string;
  nip_dosen: string;
}

interface SiaMahasiswaPayload {
  id: string;
  nim: string;
  nama_mahasiswa: string;
}

function getSiaLegacyConfig() {
  const host = process.env.SIA_LEGACY_API_HOST;
  const username = process.env.SIA_LEGACY_API_USERNAME;
  const password = process.env.SIA_LEGACY_API_PASSWORD;
  const tahunAkademik = process.env.SIA_LEGACY_TAHUN_AKADEMIK;
  const kodePS = process.env.SIA_LEGACY_KODE_PS;

  if (!host || !username || !password || !tahunAkademik || !kodePS) {
    throw new Error(
      "Missing SIA_LEGACY_API_HOST / SIA_LEGACY_API_USERNAME / SIA_LEGACY_API_PASSWORD / SIA_LEGACY_TAHUN_AKADEMIK / SIA_LEGACY_KODE_PS"
    );
  }

  return { host, username, password, tahunAkademik, kodePS };
}

function getBasicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1500;
const REQUEST_DELAY_MS = 300;

async function siaLegacyGet<T>(path: string, params: Record<string, string>) {
  const { host, username, password } = getSiaLegacyConfig();
  const url = new URL(`https://${host}/index.php/api/dev/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: getBasicAuthHeader(username, password),
        },
      });

      if (!response.ok) {
        throw new Error(`SIA legacy API ${path} failed with HTTP ${response.status}`);
      }

      const body = (await response.json()) as { status?: boolean; messages?: string } | T;
      if (body && typeof body === "object" && "status" in body && body.status === false) {
        throw new Error(`SIA legacy API ${path} rejected request: ${(body as { messages?: string }).messages}`);
      }

      await sleep(REQUEST_DELAY_MS);
      return body as T;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
}

async function fetchKelasByHari(hariKuliah: string) {
  const { tahunAkademik, kodePS } = getSiaLegacyConfig();
  return await siaLegacyGet<SiaKelasPayload[]>("kelas", {
    tahun_akademik: tahunAkademik,
    kode_PS: kodePS,
    hari_kuliah: hariKuliah,
  });
}

async function fetchMahasiswaByKelas(idKelas: number) {
  return await siaLegacyGet<SiaMahasiswaPayload[]>("kelas-mahasiswa", {
    id_kelas: String(idKelas),
  });
}

export async function syncSiaRoster() {
  const result = {
    hari: {} as Record<string, { kelas: number; mahasiswa: number }>,
    kelasProcessed: 0,
    studentsCreated: 0,
    studentsUpdated: 0,
    classLinksCreated: 0,
    classLinksSkipped: 0,
  };

  for (const hariKuliah of HARI_KULIAH_LIST) {
    const kelasList = await fetchKelasByHari(hariKuliah);
    result.hari[hariKuliah] = { kelas: kelasList.length, mahasiswa: 0 };

    for (const kelas of kelasList) {
      const mahasiswaList = await fetchMahasiswaByKelas(kelas.id);
      result.hari[hariKuliah].mahasiswa += mahasiswaList.length;
      result.kelasProcessed += 1;

      for (const mahasiswa of mahasiswaList) {
        const nim = mahasiswa.nim.trim();
        const name = mahasiswa.nama_mahasiswa.trim();

        const existingStudent = await prisma.student.findUnique({
          where: { nim },
          select: { id: true, name: true },
        });

        const student = await prisma.student.upsert({
          where: { nim },
          update: existingStudent && existingStudent.name !== name ? { name } : {},
          create: { nim, name },
        });

        if (!existingStudent) result.studentsCreated += 1;
        else if (existingStudent.name !== name) result.studentsUpdated += 1;

        await prisma.siaStudentMaster.upsert({
          where: { nim },
          update: { name },
          create: { nim, name },
        });

        const existingLink = await prisma.siaClassStudent.findUnique({
          where: { siaClassId_studentId: { siaClassId: kelas.id, studentId: student.id } },
          select: { id: true },
        });

        if (existingLink) {
          result.classLinksSkipped += 1;
          continue;
        }

        await prisma.siaClassStudent.create({
          data: {
            siaClassId: kelas.id,
            kodeMk: kelas.kode_mk,
            namaMk: kelas.nama_mk,
            namaKelas: kelas.nama_kelas,
            hariKuliah: kelas.hari_kuliah.trim(),
            tahunAkademik: kelas.tahun_akademik,
            studentId: student.id,
          },
        });
        result.classLinksCreated += 1;
      }
    }
  }

  return result;
}

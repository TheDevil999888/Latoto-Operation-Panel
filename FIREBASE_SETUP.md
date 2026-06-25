# Panduan Firebase LATOTO

## 1. Buat Project Firebase

1. Buka [Firebase Console](https://console.firebase.google.com/).
2. Klik `Add project`.
3. Isi nama project, misalnya `latoto-dashboard`.
4. Lanjutkan sampai project selesai dibuat.

## 2. Tambahkan Web App

1. Di halaman project, klik ikon `</>`.
2. Isi nama app, misalnya `latoto-web`.
3. Klik `Register app`.
4. Simpan data config yang muncul.

## 3. Aktifkan Realtime Database

1. Buka menu `Build` > `Realtime Database`.
2. Klik `Create Database`.
3. Pilih region yang paling dekat, misalnya `asia-southeast1`.
4. Mulai dulu dengan `Start in test mode`.

## 4. Isi Config Ke Project Ini

Edit file `js/firebase-config.js`, lalu ganti isinya menjadi seperti ini:

```js
window.LATOTO_FIREBASE_CONFIG = {
  apiKey: "ISI_DARI_FIREBASE",
  authDomain: "PROJECT_ID.firebaseapp.com",
  databaseURL: "https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "PROJECT_ID",
  storageBucket: "PROJECT_ID.firebasestorage.app",
  messagingSenderId: "ISI_DARI_FIREBASE",
  appId: "ISI_DARI_FIREBASE"
};

window.LATOTO_FIREBASE_PATH = "latoto-dashboard";
```

## 5. Jalankan Dashboard

1. Buka `index.html` dan `jobdesk.html`.
2. Tambahkan staff manual dari tombol `TAMBAH STAFF`.
3. Semua perubahan akan:
   - tetap tersimpan di browser
   - dikirim ke Firebase
   - ikut terupdate saat dibuka di perangkat atau tempat lain

## 6. Rules Sementara

Untuk uji awal, pakai rules berikut di Realtime Database:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

## 7. Rules Lebih Aman

Kalau dashboard sudah jadi dan mau dipakai serius, jangan biarkan rules terbuka.
Minimal pakai login atau batasi berdasarkan user tertentu.

## 8. Cara Reset Ke Kosong

Data contoh staff sudah dihapus dari template awal. Kalau mau mulai benar-benar kosong:

1. Pastikan `js/firebase-config.js` sudah terisi.
2. Hapus isi data node `latoto-dashboard` di Realtime Database.
3. Refresh dashboard.
4. Template kosong akan dibuat ulang otomatis.

## 9. Catatan Penting

- Jika `js/firebase-config.js` masih `null`, dashboard tetap jalan pakai `localStorage`.
- Kalau Firebase aktif, perubahan dari perangkat lain akan memicu refresh otomatis agar data selalu ikut terbaru.

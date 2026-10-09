@echo off
title Aplikasi Report Target Divisi - AGPC
echo ===================================================
echo   MENJALANKAN APLIKASI REPORT TARGET DIVISI AGPC
echo ===================================================
echo.

:: Mengubah direktori kerja ke lokasi file ini berada (D:\Report AGPC\)
cd /d "%~dp0"

:: 2. Jalankan Node.js Server (server.js) di jendela CMD baru
echo [1/2] Menjalankan Backend Server (server.js)...
start "Node.js Backend Server" cmd /k "node server.js"

:: 3. Tunggu 2 detik agar server siap
timeout /t 2 /nobreak >nul

:: 4. Buka file index.html otomatis di Browser bawaan
echo [2/3] Membuka Tampilan Aplikasi di Browser...
start "" "index.html"

:: 5. Buka api-url.js 
echo [3/3] Menjalankan api url...
start "set-api-url.js Backend Server" cmd /k "node set-api-url.js"


echo.
echo ===================================================
echo   Aplikasi Berhasil Dijalankan!
echo   Jangan tutup jendela CMD Backend Server.
echo ===================================================
pause
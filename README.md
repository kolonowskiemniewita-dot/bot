# Mój Dashboard Botów

Prosty panel WWW do hostowania wielu botów Discord. Każdy bot ma własny kod
i własny plik zależności (`requirements.txt` dla Pythona albo `package.json` dla Node.js).

## Jak wgrać na GitHub (bez znajomości Gita)

1. Wejdź na swoje puste repozytorium na GitHub.com
2. Kliknij **"Add file" → "Upload files"**
3. Przeciągnij te pliki: `server.js`, `package.json`, `Dockerfile`, `.gitignore`, `README.md` (bez folderów — wszystko jest teraz w jednym miejscu)
4. Na dole kliknij **"Commit changes"** — GitHub zapyta, czy nadpisać istniejące pliki, potwierdź

## Jak podłączyć do Render

1. Wróć do Render → New Web Service → wybierz to repozytorium
2. **Language: Docker** (zostaw tak, bo mamy Dockerfile)
3. **Instance Type: Free**
4. W sekcji **Environment Variables** dodaj:
   - `DASHBOARD_PASSWORD` = jakieś Twoje hasło do panelu
5. (Opcjonalnie) dodaj `MAX_BOT_MEMORY_MB` = np. `256` — to maksymalna ilość RAM na JEDNEGO bota; jeśli bot przekroczy limit, dashboard sam go zatrzyma. Domyślnie ustawione na 256 MB.
6. Kliknij **Deploy**

Po chwili Render poda Ci adres, np. `https://bot-xxxx.onrender.com` — to Twój dashboard.

## Jak dodać własnego bota

1. Kod swojego bota (np. `main.py` + `requirements.txt`, albo `index.js` + `package.json`) spakuj do pliku **.zip**
2. Na dashboardzie wpisz nazwę, wybierz typ (Python/Node), wklej token bota, wybierz plik .zip
3. Kliknij "Wgraj bota", potem "Start"

## Ważne: darmowy plan Render usypia po bezczynności

Żeby bot nie usypiał, załóż darmowe konto na **UptimeRobot.com** i dodaj monitor,
który odwiedza Twój adres dashboardu (np. `https://bot-xxxx.onrender.com`) co 5 minut.

## Bezpieczeństwo (ważne, jeśli inni mają mieć dostęp)

To jest wersja podstawowa: hasło ustawione jako `DASHBOARD_PASSWORD` w zmiennych
środowiskowych **nie blokuje jeszcze w pełni dostępu do panelu** — to prosty szkielet
do dalszej rozbudowy, nie gotowe rozwiązanie produkcyjne dla obcych osób.
Jeśli tylko Ty masz z niego korzystać, nie ma problemu.

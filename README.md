# Peitsch den Markus: Survivors 🪢

Ein Survivors-like im Browser: Du steuerst einen Peitschenschwinger, der sich
gegen eine ständig wachsende Horde von Markus-Köpfen zur Wehr setzen muss.
Bewegen, überleben, XP sammeln, aufleveln, stärker werden – bis die Horde dich
irgendwann doch einholt.

## Spielen

Öffne einfach `index.html` in einem Browser – keine Installation nötig. Falls
dein Browser lokale Bilder/Skripte per `file://` blockiert, reicht auch ein
beliebiger statischer Server, z. B.:

```
python3 -m http.server 8000
```

… und dann `http://localhost:8000/` öffnen.

## Steuerung

- **WASD / Pfeiltasten**: Bewegen. Waffen feuern automatisch in Bewegungsrichtung.
- **Finger ziehen** (Touch): Virtueller Joystick – an beliebiger Stelle auf dem
  Spielfeld antippen und ziehen.
- **Esc**: Pause (jede Taste setzt fort).
- **1 / 2 / 3** oder Klick/Tippen: Level-Up-Karte auswählen.

## Ablauf

- Feinde ("Markus"-Köpfe) spawnen am Bildschirmrand und rücken auf dich zu;
  je länger die Runde läuft, desto mehr und desto härter wird es.
- Getötete Feinde lassen XP-Kristalle fallen. Ist die XP-Leiste voll, gibt's
  einen Level-Up mit 3 zufälligen Karten zur Auswahl.
- Berührt dich ein Feind, verlierst du HP (kurze Unverwundbarkeit nach jedem
  Treffer). Bei 0 HP ist die Runde vorbei – die beste Überlebenszeit wird
  lokal gespeichert.

## Waffen (max. Stufe 5)

| Icon | Name | Beschreibung |
|---|---|---|
| 🪢 | Klassische Peitsche | Startwaffe. Peitscht automatisch nach vorn in Blickrichtung. |
| 🌀 | Kreiselpeitsche | Peitschenspitzen kreisen dauerhaft um dich und verletzen alles, was sie berühren. |
| ⚡ | Blitzpeitsche | Schlägt in Abständen als Blitz beim nächsten Feind ein, kann auf weitere Gegner überspringen. |
| 🔥 | Flammenpeitsche | Peitscht einen brennenden Kegel vor dir und hinterlässt Feuerflecken, die weiter Schaden machen. |
| 🪃 | Schleuderpeitsche | Schleudert spinnende Peitschenknoten, die durch Gegner fliegen und zu dir zurückkehren. |
| ❄️ | Frostpeitsche | Frost-Nova um dich herum: verletzt und verlangsamt alle Feinde in Reichweite. |

## Passive Items (max. Stufe 3)

| Icon | Name | Beschreibung |
|---|---|---|
| 👢 | Stiefel | +12 % Lauftempo pro Stufe. |
| 🧲 | Magnetring | +45 % Aufsammelradius für XP-Kristalle pro Stufe. |
| ❤️ | Markus-Herz | +25 max. HP pro Stufe, heilt beim Aufnehmen sofort 25 HP. |
| ⏳ | Sanduhr | Alle Waffen-Cooldowns ×0,9 pro Stufe (stapelt sich). |

Reicht der Kartenpool nicht (z. B. wenn schon alles maximiert ist), springt
als Notlösung die 🥨 **Brezel**-Karte ein: +30 HP, sofort.

## Level- & Slot-Regeln

- Maximal **4 Waffen** und **3 passive Items** gleichzeitig aktiv.
- Jede Waffe/jedes Item lässt sich unabhängig aufleveln (Waffen bis Stufe 5,
  Passive bis Stufe 3); alle Werte pro Stufe stehen in eigenen Datentabellen
  in `js/weapons.js`.
- Beim Level-Up bekommst du 3 zufällige Karten aus dem Pool aus: Upgrades für
  bereits besessene, noch nicht maximierte Waffen/Items, neue Waffen (solange
  Slots frei sind) und neue passive Items (solange Slots frei sind).

## Technik

- Reines HTML5 Canvas 2D + JavaScript, keine externen Abhängigkeiten,
  keine Build-Schritte.
- `js/core.js` ist die Engine (Spieler, Gegner, Kamera, XP/Leveling, HUD,
  State-Machine); `js/weapons.js` enthält alle Waffen und passiven Items nach
  einem kleinen, dokumentierten Plugin-API. Beide teilen sich `window.MG`.
- Sound-Effekte werden per WebAudio zur Laufzeit synthetisiert (keine
  Audiodateien).
- Das Gegner-Sprite liegt unter `assets/markus.png` und wird beim Laden per
  Chroma-Key freigestellt.
- Debug-Hook für QA/Tests: `window.__game` (`gainXP(n)`, `player`, `enemies`,
  `time`, …).

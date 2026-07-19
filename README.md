# Peitsch den Markus: Survivors 3D 🪢

Ein 3D-Survivors-like im Browser (Stil: Megabonk): Du steuerst einen
Peitschenschwinger durch eine endlose, sonnige Low-Poly-Wiese und wehrst dich
gegen eine ständig wachsende Horde von Markus-Köpfen – inklusive dicker
Boss-Markusse. Bewegen, überleben, XP sammeln, aufleveln, Truhen plündern,
Schreine für permanente Boni finden – bis die Horde dich irgendwann doch
einholt. Die Minimap oben links zeigt dir immer den Weg.

## Spielen

Öffne einfach `index.html` in einem Browser – keine Installation nötig. Falls
dein Browser lokale Bilder/Skripte per `file://` blockiert, reicht auch ein
beliebiger statischer Server, z. B.:

```
python3 -m http.server 8000
```

… und dann `http://localhost:8000/` öffnen.

## Steuerung

- **WASD / Pfeiltasten**: Bewegen. Waffen feuern automatisch in Blickrichtung.
- **Finger ziehen** (Touch): Virtueller Joystick – an beliebiger Stelle auf dem
  Spielfeld antippen und ziehen.
- **Esc**: Pause (jede Taste setzt fort).
- **1 / 2 / 3** oder Klick/Tippen: Level-Up-Karte auswählen.

## Ablauf

- Feinde ("Markus"-Köpfe) tauchen am Rand des Sichtfelds auf und rücken auf
  dich zu; je länger die Runde läuft, desto mehr und desto härter wird es
  (Spawn-Tempo und HP-Wachstum ziehen mit der Zeit spürbar an, bis zu
  350 gleichzeitigen Gegnern). Ab 2:30 kommen Wüteriche dazu (schnell und
  bissig), ab 4:00 Teiler, die beim Tod in zwei flinke Mini-Markusse
  zerfallen. Ab 4:30 taucht der **Doppelmarkus** auf – eine zweiköpfige
  Verschmelzung, die beim Tod in einen normalen und einen Wüterich-Markus
  zerfällt – und ab 6:00 der **Markus-Riese**, eine riesige, dunkel
  eingefärbte Version davon, die gleich in drei Wüteriche zerfällt.
- Ab Minute 2 erscheint alle ~90 Sekunden ein **Boss-Markus** (💀 auf der
  Minimap): groß, zäh (wird mit jedem Boss zäher), roter Bodenring. Zur
  Belohnung lässt er eine Truhe und einen XP-Kranz fallen.
- Die **Minimap** (oben links, direkt unter der HP-Leiste) zeigt die Horde
  als Punkte sowie 💀 Bosse, ⭐ Schreine, 🧰 Truhen, Essen und 🌟 den
  Goldenen Markus; was außer Reichweite ist, klebt als Richtungspfeil am
  Kartenrand.
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
| ❄️ | Frostpeitsche | Frost-Nova um dich herum: verletzt und verlangsamt alle Feinde in Reichweite. |
| 👻 | Geisterpeitsche | Beschwört zielsuchende Geister, die den nächsten Markus jagen und beim Aufprall zerplatzen. |

Drei der Passiv-Items (siehe unten) wirken direkt auf diese Waffen: mehr
Projektile/Seiten/Spitzen/Ketten/Orbs (bei allen außer der Frostpeitsche,
die als einzelner Flächenpuls kein Projektil-Konzept hat), größere
Hitboxen/Effekte (ausnahmslos bei allen sechs) und mehr Tempo bei allem,
was tatsächlich fliegt oder rotiert (Geisterpeitsche, Kreiselpeitsche).

## Passive Items (max. Stufe 3-4)

| Icon | Name | Beschreibung |
|---|---|---|
| 🧲 | Magnetring | +45 % Aufsammelradius für XP-Kristalle pro Stufe (max. Stufe 3). |
| ❤️ | Markus-Herz | +25 max. HP pro Stufe, heilt beim Aufnehmen sofort 25 HP (max. Stufe 3). |
| ⏳ | Sanduhr | Alle Waffen-Cooldowns ×0,9 pro Stufe, stapelt sich (max. Stufe 3). |
| 🧶 | Knotensack | +1 Projektil/Seite/Spitze/Kette/Orb pro Stufe (max. Stufe 3). |
| 🫧 | Riesenknoten | +18 % Projektil-/Effektgröße pro Stufe: Hitboxen, Nova-Radius, Orb-Reichweite... (max. Stufe 3). |
| 🌪️ | Peitschenöl | +20 % Projektiltempo pro Stufe: schnellere Geister-Orbs, schnellere Kreiselpeitsche (max. Stufe 3). |

Reicht der Kartenpool nicht (z. B. wenn schon alles maximiert ist), springt
als Notlösung die 🥨 **Brezel**-Karte ein: +30 HP, sofort.

## Schreine ⛩️ (permanente Upgrades)

Ab Minute 1 taucht regelmäßig ein leuchtender Schrein auf (⭐ auf der
Minimap, maximal 1 gleichzeitig, verschwindet nie von selbst). Lauf hinein
und du bekommst einen zufälligen **permanenten** Bonus für den Rest der
Runde:

| Bonus | Effekt |
|---|---|
| 💪 | +15 % Schaden (alle Waffen) |
| 👟 | +10 % Lauftempo |
| ❤️ | +20 max. HP (und sofort geheilt) |
| ✨ | +15 % XP aus Kristallen |
| ⚡ | −8 % Abklingzeit auf alles |

Die Boni stapeln sich – wer fleißig Schreine abläuft, wird spürbar stärker.

## Truhen 🧰

Alle 45–70 Sekunden erscheint irgendwo in deiner Nähe eine Truhe (maximal 2
gleichzeitig). Lauf einfach hinein, um sie zu öffnen:

- **60 %**: Sofortiges Upgrade einer zufälligen, noch nicht maximierten
  Waffe / eines passiven Items (wird kurz eingeblendet).
- **25 %**: Ein Essens-Item springt heraus.
- **15 %**: XP-Jackpot – 5 goldene Kristalle bersten heraus.

Gibt es nichts mehr zu verbessern, gibt's automatisch den Jackpot.

## Essen 🥨

Besiegte Markusse lassen mit 4 % Chance etwas Essbares fallen (maximal 5
gleichzeitig, verschwindet nach 45 s). Essen wird **nicht** vom Magneten
angezogen – du musst drüberlaufen:

| Icon | Name | Effekt |
|---|---|---|
| 🥨 | Brezel | Heilt 30 HP. |
| 🥩 | Schnitzel | Heilt 60 HP. |
| 🍺 | Maß | 8 s Berserker: alle Waffen-Cooldowns ×0,6 (stapelt mit der Sanduhr). |
| 🧀 | Käsebrot | +10 max. HP für diese Runde und heilt 20 HP. |

## Der Goldene Markus 🌟

Ab Sekunde 45 taucht alle 60–90 Sekunden (nie mehr als einer gleichzeitig)
ein scheuer, goldener Markus-Kopf auf – auf der Minimap als 🌟 markiert.
Er ist völlig harmlos (macht keinen Schaden) und **flieht** vor dir, statt
dich anzugreifen. Erwischst du ihn, bevor er nach 12 Sekunden von selbst
wieder verschwindet, platzen 8 goldene XP-Kristalle plus garantiert ein
Essens-Item aus ihm heraus – eine seltene, lohnende Verfolgungsjagd.

## Level- & Slot-Regeln

- Maximal **4 Waffen** und **4 passive Items** gleichzeitig aktiv.
- Die Slot-Leiste oben (mittig unter dem Timer) zeigt das direkt: 4
  golden umrandete Waffen-Slots, eine kleine Lücke, dann 4 cyan umrandete
  Passiv-Slots. Belegte Slots zeigen Icon + Stufen-Abzeichen, freie Slots
  bleiben gestrichelt und abgedunkelt.
- Jede Waffe/jedes Item lässt sich unabhängig aufleveln (Waffen bis Stufe 5,
  Passive bis Stufe 3); alle Werte pro Stufe stehen in eigenen Datentabellen
  in `js/weapons.js`.
- Beim Level-Up bekommst du 3 zufällige Karten aus dem Pool: Upgrades für
  bereits besessene, noch nicht maximierte Waffen/Items, neue Waffen (solange
  Slots frei sind) und neue passive Items (solange Slots frei sind).

## Technik

- HTML5 + JavaScript + WebGL über **three.js r147** (UMD-Build, lokal
  vendored unter `vendor/three.min.js`) – keine CDN-Abhängigkeiten, keine
  Build-Schritte.
- Das Gameplay läuft komplett auf der XZ-Bodenebene (Kamera folgt in der
  dritten Person); alle Tuning-Werte stammen 1:1 aus der 2D-Version und
  werden über eine einzige Konstante (40 px = 1 Welteinheit) umgerechnet.
- `js/core.js`: Engine (Szene/Kamera, Spieler, Gegner-Billboards, XP/Leveling,
  HUD, State-Machine). `js/weapons.js`: alle Waffen und Passiven über ein
  kleines, dokumentiertes Plugin-API. `js/systems.js`: Truhen & Essen.
  Alle teilen sich `window.MG`.
- Boden ist eine prozedurale CanvasTexture (grüne Wiese mit Mottling);
  Himmel ist ein Gradient-Hintergrund mit driftenden Wolken-Billboards;
  Markus-Gegner sind chroma-gekeyte Billboard-Sprites; Deko (Felsen, Bäume,
  Gras, Bauwerke) per InstancedMesh.
- Das zweite Gegner-Gesicht wird aus `assets/markus2.png` geladen; fehlt die
  Datei, nutzen die betroffenen Gegnertypen automatisch das erste Gesicht mit
  ihrer jeweiligen Erkennungsfarbe. Doppelmarkus/Markus-Riese nutzen
  stattdessen eine einmalig zusammengesetzte "Amalgam"-Textur (beide
  Gesichter überlappend auf einem Canvas), sobald beide Gesichts-Assets
  geladen sind – fehlt `markus2.png`, wird das erste Gesicht gespiegelt als
  zweiter Kopf verwendet.
- Minimap (oben links, direkt unter der HP-Leiste) ist ein 2D-Canvas-Overlay,
  das jede Frame Spieler, Horde, Bosse, Schreine, Truhen, Essen und den
  Goldenen Markus plottet (mit Rand-Clamping für ferne Ziele).
- Sound-Effekte werden per WebAudio zur Laufzeit synthetisiert (keine
  Audiodateien).
- Debug-Hook für QA/Tests: `window.__game` (`gainXP(n)`, `player`, `enemies`,
  `time`, `renderer`, …).

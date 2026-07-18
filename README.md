# Peitsch den Markus! 🎯

Ein einfaches Browser-Spiel. Markus-Köpfe fliegen durch die Luft, drehen sich und
fallen wieder nach unten. Deine Aufgabe: **Lass keinen Markus unten durch den
Bildschirm fallen!**

## Spielen

Öffne einfach `index.html` in einem Browser – keine Installation, kein Server nötig.

## Steuerung

- **Maus / Finger**: Bewegt die Peitsche.
- **Klick / Tippen** auf oder neben einen Kopf: Schleudert ihn mit einem
  Peitschenhieb wieder nach oben.

## Regeln

- Jeder Kopf, der unten durchfällt, kostet ein Leben (❤️❤️❤️).
- Für jeden Treffer gibt es Punkte.
- Alle 18 Sekunden steigt das Level: stärkere Schwerkraft und mehr Köpfe
  spawnen – es wird immer hektischer.
- Sind alle Leben weg, ist die Runde vorbei. Der beste Wert wird lokal
  gespeichert.

## Technik

- Reines HTML5 Canvas + JavaScript, keine externen Abhängigkeiten.
- Sound-Effekte werden per WebAudio erzeugt (keine Audiodateien).
- Das Bild liegt unter `assets/markus.png`.

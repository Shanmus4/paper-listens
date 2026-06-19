# Paper Listens

Play your music, the paper is listening.

**Paper Listens** turns any sound into watercolor. Play a guitar, sing, hum, beatbox, or upload a song, and it paints onto a sheet of paper in real time. The colors are not random: every musical note maps to a fixed color and a fixed spot on the page, so the same song always paints the same picture. Bright, happy scales paint in vibrant colors. Dark, moody scales paint in muted ones. Drums add their own ink texture.

It is a kind of synesthesia for your browser, hearing turned into seeing.

## Who is this for

Anyone curious about the link between music and color. Musicians who want to *see* what they play. People who just want to make something beautiful by making noise. No coding knowledge needed to use it, just a microphone and a browser.

## How it works (in plain English)

1. The browser listens to your microphone (with your permission).
2. It breaks the sound down into musical notes, loudness, and brightness, many times a second.
3. Each note gets a color (based on a color wheel of the 12 musical notes) and a fixed position on the page.
4. The app figures out which musical scale you are in and adjusts how vibrant the whole painting feels.
5. Watercolor blots bleed onto the paper, one per note. Drums become grey ink splatters.

Nothing is uploaded to a server. All the listening and painting happens on your own device.

## Tech

- Plain HTML, CSS, and JavaScript. No framework, no build step.
- **Web Audio API** to capture and analyze sound.
- **Meyda** for audio feature extraction (which notes are present, loudness, brightness).
- **Canvas 2D** to paint the watercolor.
- Hosted on **Vercel** as a static site.

## Run it locally

You need a recent version of Node.js installed (for the simple local server).

```bash
# from the project folder
npm run dev
```

Then open the printed URL (usually http://localhost:3000) in your browser and allow microphone access.

> A microphone needs a secure context. `localhost` counts as secure, so local development works. If you open the raw `index.html` file directly (a `file://` URL) the microphone will not work.

## Controls

- **New Sheet**: clear the paper and start fresh.
- **Save**: download your painting as a PNG image.
- **Back**: return to the start screen.

## Roadmap

- **Now**: live microphone painting with notes, chords, vocals, and drums.
- **Next**: upload an MP3 or WAV file and paint the whole song. Paste a Spotify track link.
- **Later**: different painting styles (minimal, maximal), sensitivity controls, undo, and shareable links.

## Troubleshooting

- **Nothing paints**: check the browser asked for and got microphone permission. Look for a mic icon in the address bar.
- **Microphone permission never appears**: you may be opening the file directly. Use `npm run dev` and open `localhost` instead.
- **iPhone Safari shows nothing**: tap the "tap to listen" prompt first. Audio cannot start on iOS until you tap.

## License

MIT
